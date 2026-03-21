"""Extract ARECO settlement master zip into ARECO / ARECOSS folder layout.

**Zip layers (password usage)**

1. **Master zip** (uploaded file from the other app) — **not** encrypted; opened with no password.
2. **Branch zips** (first files inside the master: names ending in ``_ARECO`` / ``_ARECOSS``) —
   **encrypted**; ``ARECO_SETTLEMENT_ZIP_PASSWORD1`` then ``…_PASSWORD2`` then unencrypted
   (same order as Excel / WinRAR batch).
3. **Daily zips** inside each branch (``ARECO_Energy_YYYYMMDD_…`` / ``ARECOSS_Energy_…``) —
   **encrypted** with the **same** two passwords (then unencrypted fallback).
4. **Data files** inside each daily zip (``.xlsx`` / ``.xlsm`` / ``.xls`` or ``.csv``; often after **nested .zip** layers) —
   same passwords; unwrapped up to a few levels. Output uses fixed folders (no date in folder name):
   ``ARECO/ARECO_ENERGY``, ``ARECO/ARECO_SEIN``, ``ARECOSS/ARECOSS_ENERGY``, ``ARECOSS/ARECOSS_SEIN``,
   based on whether the **daily zip** name is ``…Energy_YYYYMMDD…`` vs ``…Energy-SEIN_YYYYMMDD…``
   (also accepts ``Energy_SEIN_``).

Reimplements the *intent* of ``Extract Template_Pears_.xlsm`` / WinRAR batch for steps 2–3.
This module does not run VBA, ``.bat``, or WinRAR — only ``zipfile`` + filesystem layout.
"""
from __future__ import annotations

import io
import os
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from typing import BinaryIO

def _parse_daily_energy_zip(filename: str) -> tuple[str, str] | None:
    """
    Recognize daily zips under the branch tree.

    Returns ``(yyyymmdd, kind)`` where ``kind`` is ``"energy"`` or ``"sein"``, else ``None``.

    Examples::

        ARECO_Energy_20260126_ER_FINAL.zip          -> energy
        ARECO_Energy-SEIN_20260215_ER_FINAL.zip     -> sein
        ARECOSS_Energy_20260215_ER_FINAL.zip       -> energy
        ARECOSS_Energy-SEIN_20260215_ER_FINAL.zip  -> sein
    """
    # SEIN variant first (hyphen or underscore before SEIN)
    m = re.search(r"Energy[-_]SEIN_(\d{8})", filename, re.IGNORECASE)
    if m:
        return m.group(1), "sein"
    m = re.search(r"Energy_(\d{8})", filename, re.IGNORECASE)
    if m:
        return m.group(1), "energy"
    return None


def _output_folder_for_daily(branch_folder_name: str, kind: str) -> str:
    """``branch_folder_name`` is ``ARECO`` or ``ARECOSS`` (basename of branch root)."""
    if branch_folder_name == "ARECO":
        return "ARECO_SEIN" if kind == "sein" else "ARECO_ENERGY"
    if branch_folder_name == "ARECOSS":
        return "ARECOSS_SEIN" if kind == "sein" else "ARECOSS_ENERGY"
    raise ValueError(f"Unexpected branch folder: {branch_folder_name!r}")


def _is_spreadsheet_filename(filename: str) -> bool:
    """Leaf files we copy into ARECO_* / ARECOSS_* (Excel workbooks or settlement CSV)."""
    lower = filename.lower()
    return (
        lower.endswith(".xlsx")
        or lower.endswith(".xlsm")
        or lower.endswith(".xls")
        or lower.endswith(".csv")
    )


# Daily zips often contain a single inner .zip; unwrap with the same passwords as the daily.
_MAX_NESTED_ZIP_DEPTH = 8


def _collect_spreadsheets_unwrapping_nested_zips(
    directory: str,
    passwords: list[str],
    *,
    persistent_staging_root: str,
    max_nested_zip: int = _MAX_NESTED_ZIP_DEPTH,
    _zip_depth: int = 0,
) -> tuple[list[tuple[str, str]], int]:
    """
    Find workbooks / CSV under ``directory``. If a ``.zip`` is found, extract it (trying
    ``passwords`` like other layers) and search inside — repeats up to ``max_nested_zip``.

    Nested archives are extracted under ``persistent_staging_root`` (the daily zip's work
    dir) so paths remain valid until the caller moves files out — not a short-lived temp
    dir that is deleted before ``shutil.move``.

    Returns ``( [(abs_path, basename), ...], skipped_count )`` for leaf files not consumed.
    """
    collected: list[tuple[str, str]] = []
    skipped = 0
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return [], 0

    for entry in names:
        path = os.path.join(directory, entry)
        if os.path.isdir(path):
            sub, sk = _collect_spreadsheets_unwrapping_nested_zips(
                path,
                passwords,
                persistent_staging_root=persistent_staging_root,
                max_nested_zip=max_nested_zip,
                _zip_depth=_zip_depth,
            )
            collected.extend(sub)
            skipped += sk
            continue

        if _is_spreadsheet_filename(entry):
            collected.append((path, entry))
            continue

        if entry.lower().endswith(".zip") and _zip_depth < max_nested_zip:
            nz = tempfile.mkdtemp(dir=persistent_staging_root, prefix="nested_day_")
            try:
                _extract_zip_path_try_passwords(path, nz, passwords)
            except Exception:
                skipped += 1
                shutil.rmtree(nz, ignore_errors=True)
                continue
            sub, sk = _collect_spreadsheets_unwrapping_nested_zips(
                nz,
                passwords,
                persistent_staging_root=persistent_staging_root,
                max_nested_zip=max_nested_zip,
                _zip_depth=_zip_depth + 1,
            )
            collected.extend(sub)
            skipped += sk
            if len(sub) == 0:
                skipped += 1
            continue

        skipped += 1

    return collected, skipped


@dataclass
class ExtractResult:
    ok: bool
    output_dir: str
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    areco_days: list[str] = field(default_factory=list)
    arecoss_days: list[str] = field(default_factory=list)
    files_placed: list[dict[str, str]] = field(default_factory=list)


def _norm_date_yyyy_mm_dd(ymd: str) -> str:
    d = datetime.strptime(ymd, "%Y%m%d").date()
    return d.isoformat()


def _extract_zip_bytes(
    data: bytes,
    dest_dir: str,
    password: str | None = None,
) -> None:
    pwd = password.encode("utf-8") if password else None
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for m in zf.infolist():
            if m.filename.endswith("/"):
                continue
            with zf.open(m, pwd=pwd) as src:
                pass  # test decrypt
        for m in zf.infolist():
            _safe_extract_member_from_open(zf, m, dest_dir, pwd)


def _safe_extract_member_from_open(
    zf: zipfile.ZipFile,
    member: zipfile.ZipInfo,
    dest_dir: str,
    pwd: bytes | None,
) -> None:
    name = member.filename.replace("\\", "/")
    if name.startswith("/") or ".." in name.split("/"):
        raise ValueError(f"Unsafe zip entry: {member.filename!r}")
    target = os.path.normpath(os.path.join(dest_dir, member.filename))
    dest_abs = os.path.abspath(dest_dir)
    target_abs = os.path.abspath(target)
    if not (target_abs == dest_abs or target_abs.startswith(dest_abs + os.sep)):
        raise ValueError(f"Unsafe zip entry path: {member.filename!r}")
    if member.is_dir():
        os.makedirs(target_abs, exist_ok=True)
        return
    parent = os.path.dirname(target_abs)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with zf.open(member, pwd=pwd) as src, open(target_abs, "wb") as out:
        shutil.copyfileobj(src, out)


def _extract_zip_path(path: str, dest_dir: str, password: str | None = None) -> None:
    pwd = password.encode("utf-8") if password else None
    with zipfile.ZipFile(path) as zf:
        for m in zf.infolist():
            if m.filename.endswith("/"):
                continue
            with zf.open(m, pwd=pwd):
                pass
        for m in zf.infolist():
            _safe_extract_member_from_open(zf, m, dest_dir, pwd)


def _find_branch_zips(root: str) -> tuple[str | None, str | None]:
    """Return paths to inner …_ARECO and …_ARECOSS settlement zips."""
    areco: str | None = None
    arecoss: str | None = None
    for dirpath, _, files in os.walk(root):
        for f in files:
            if not f.lower().endswith(".zip"):
                continue
            full = os.path.join(dirpath, f)
            stem = f[: -len(".zip")] if f.lower().endswith(".zip") else f
            if stem.endswith("_ARECOSS"):
                arecoss = full
            elif stem.endswith("_ARECO"):
                areco = full
    return areco, arecoss


def _collect_daily_zips(folder: str) -> list[tuple[str, str, str]]:
    """List ``(full_path, yyyymmdd, kind)`` for daily Energy / Energy-SEIN zips (any depth under branch)."""
    out: list[tuple[str, str, str]] = []
    for dirpath, _, files in os.walk(folder):
        for f in files:
            if not f.lower().endswith(".zip"):
                continue
            parsed = _parse_daily_energy_zip(f)
            if not parsed:
                continue
            ymd, kind = parsed
            out.append((os.path.join(dirpath, f), ymd, kind))
    out.sort(key=lambda x: (x[1], x[2]))
    return out


def _clear_dir_contents(path: str) -> None:
    if not os.path.isdir(path):
        return
    for name in os.listdir(path):
        full = os.path.join(path, name)
        if os.path.isdir(full):
            shutil.rmtree(full, ignore_errors=True)
        else:
            try:
                os.unlink(full)
            except OSError:
                pass


def _daily_zip_password_attempts(passwords: list[str]) -> list[str | None]:
    """Try explicit passwords first (Excel / WinRAR order), then unencrypted."""
    seen: set[str] = set()
    ordered: list[str] = []
    for p in passwords:
        s = (p or "").strip()
        if s and s not in seen:
            seen.add(s)
            ordered.append(s)
    if ordered:
        return [*ordered, None]
    return [None]


def _extract_zip_path_try_passwords(path: str, dest_dir: str, passwords: list[str]) -> None:
    """Extract ``path`` into ``dest_dir``, trying each password then unencrypted (dest cleared per try)."""
    attempts = _daily_zip_password_attempts(passwords)
    last_err: Exception | None = None
    for pwd in attempts:
        _clear_dir_contents(dest_dir)
        try:
            _extract_zip_path(path, dest_dir, password=pwd)
            return
        except (RuntimeError, zipfile.BadZipFile, ValueError, OSError) as e:
            last_err = e
    if last_err is not None:
        raise last_err


def _process_daily_zip(
    zip_path: str,
    ymd: str,
    kind: str,
    branch_root: str,
    passwords: list[str],
    placed: list[dict[str, str]],
    warnings: list[str],
) -> None:
    """Layer 3: daily Energy / Energy-SEIN zip; layer 4 workbooks/CSV go to ARECO_* / ARECOSS_* folders."""
    date_iso = _norm_date_yyyy_mm_dd(ymd)
    branch_name = os.path.basename(os.path.normpath(branch_root))
    out_folder = _output_folder_for_daily(branch_name, kind)
    with tempfile.TemporaryDirectory(prefix="dayzip_") as td:
        work = os.path.join(td, "_work")
        os.makedirs(work, exist_ok=True)
        attempts_n = len(_daily_zip_password_attempts(passwords))
        try:
            # Layer 3: daily Energy zip (passwords same as branch bundles).
            _extract_zip_path_try_passwords(zip_path, work, passwords)
        except Exception as e:
            raise ValueError(
                f"Failed to extract {os.path.basename(zip_path)!r} (tried "
                f"{attempts_n} password option(s)): {e}"
            ) from e

        dest_dir = os.path.join(branch_root, out_folder)
        os.makedirs(dest_dir, exist_ok=True)
        candidates, skipped = _collect_spreadsheets_unwrapping_nested_zips(
            work, passwords, persistent_staging_root=work
        )
        if not candidates:
            warnings.append(
                f"No .xlsx/.xlsm/.xls/.csv in {os.path.basename(zip_path)!r} "
                f"(searched nested .zip up to {_MAX_NESTED_ZIP_DEPTH} levels; "
                f"skipped {skipped} other file(s))."
            )
            return

        for src, fname in candidates:
            dest_file = os.path.join(dest_dir, fname)
            if os.path.exists(dest_file):
                try:
                    same = os.path.samefile(src, dest_file)
                except OSError:
                    same = False
                if not same:
                    warnings.append(f"Overwrote: {dest_file}")
            shutil.move(src, dest_file)
            placed.append(
                {
                    "branch": branch_name,
                    "date": date_iso,
                    "folder": out_folder,
                    "file": fname,
                }
            )
        if skipped:
            warnings.append(
                f"Skipped {skipped} file(s) in {os.path.basename(zip_path)!r} "
                f"(not .xlsx/.xlsm/.xls/.csv and not unwrapped to those; target {out_folder!r})."
            )


def extract_settlement_master(
    master_stream: BinaryIO,
    output_dir: str,
    *,
    zip_passwords: list[str] | None = None,
) -> ExtractResult:
    """
    Layout (see module docstring for zip layers)::

        output_dir/ARECO/ARECO_ENERGY/*.{xlsx,xlsm,xls,csv}
        output_dir/ARECO/ARECO_SEIN/*.{xlsx,xlsm,xls,csv}
        output_dir/ARECOSS/ARECOSS_ENERGY/*.{xlsx,xlsm,xls,csv}
        output_dir/ARECOSS/ARECOSS_SEIN/*.{xlsx,xlsm,xls,csv}
    """
    errors: list[str] = []
    warnings: list[str] = []
    placed: list[dict[str, str]] = []
    areco_days: list[str] = []
    arecoss_days: list[str] = []
    pw_list = list(zip_passwords) if zip_passwords is not None else []

    out_abs = os.path.abspath(output_dir)
    if not out_abs:
        return ExtractResult(False, output_dir, errors=["Output directory is empty."])

    os.makedirs(out_abs, exist_ok=True)

    areco_root = os.path.join(out_abs, "ARECO")
    arecoss_root = os.path.join(out_abs, "ARECOSS")
    os.makedirs(areco_root, exist_ok=True)
    os.makedirs(arecoss_root, exist_ok=True)

    master_bytes = master_stream.read()
    if not master_bytes:
        return ExtractResult(False, out_abs, errors=["Uploaded file is empty."])

    try:
        with tempfile.TemporaryDirectory(prefix="settlement_master_") as tmp_master:
            # Layer 1: master archive is not password-protected.
            _extract_zip_bytes(master_bytes, tmp_master, password=None)
            path_areco, path_arecoss = _find_branch_zips(tmp_master)

            if not path_areco:
                errors.append("Could not find inner zip ending with _ARECO (generator).")
            if not path_arecoss:
                errors.append("Could not find inner zip ending with _ARECOSS (load).")
            if errors:
                return ExtractResult(False, out_abs, errors=errors, warnings=warnings)

            for label, inner_path, branch_root, day_list in (
                ("ARECO", path_areco, areco_root, areco_days),
                ("ARECOSS", path_arecoss, arecoss_root, arecoss_days),
            ):
                with tempfile.TemporaryDirectory(prefix=f"branch_{label}_") as td_inner:
                    try:
                        # Layer 2: _ARECO / _ARECOSS bundle zips are password-protected.
                        _extract_zip_path_try_passwords(inner_path, td_inner, pw_list)
                    except Exception as e:
                        errors.append(f"Failed to extract {label} bundle: {e}")
                        continue
                    dailies = _collect_daily_zips(td_inner)
                    if not dailies:
                        warnings.append(
                            f"No daily ARECO*_Energy_* or *_Energy-SEIN_* zips found under {label} bundle."
                        )
                    for zpath, ymd, kind in dailies:
                        day_list.append(_norm_date_yyyy_mm_dd(ymd))
                        try:
                            _process_daily_zip(
                                zpath, ymd, kind, branch_root, pw_list, placed, warnings
                            )
                        except ValueError as e:
                            errors.append(str(e))

    except zipfile.BadZipFile as e:
        return ExtractResult(False, out_abs, errors=[f"Not a valid zip file: {e}"])
    except Exception as e:
        return ExtractResult(False, out_abs, errors=[f"Extraction failed: {e}"])

    ok = len(errors) == 0
    return ExtractResult(
        ok=ok,
        output_dir=out_abs,
        errors=errors,
        warnings=warnings,
        areco_days=sorted(set(areco_days)),
        arecoss_days=sorted(set(arecoss_days)),
        files_placed=placed,
    )
