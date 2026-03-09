"""
Tkinter GUI for Day Ahead Nomination: forecast date, Rev #, table (Interval | Day Ahead | RTD), Export XML.
Day Ahead = from CSV upload or paste (from forecasting tool). RTD = manual input only. Table is the preview.
"""
import re
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
from datetime import date, datetime, timedelta

from . import config
from .nomination_build import build_raw_bid_set, INTERVALS_PER_DAY
from .nomination_xml import write_raw_bid_set


def _parse_numbers_from_text(text: str) -> list[float]:
    """Parse text into a list of numbers (newlines, tabs, commas, semicolons). Same as paste."""
    if not text or not text.strip():
        return []
    numbers = []
    for part in re.split(r"[\r\n\t,;]+", text.strip()):
        part = part.strip()
        if not part:
            continue
        try:
            numbers.append(float(part))
        except ValueError:
            continue
    return numbers


# Solar curve: approximate "sun out" hours (Philippines). Hour 0 = 00:00, 6 = 06:00, 18 = 18:00.
# 0 MW for hours 0-5 and 19-23; ramp up 6-8, flat 9-15, ramp down 16-18.
SUN_START_HOUR = 6   # 06:00
SUN_PEAK_START = 9   # 09:00
SUN_PEAK_END = 15    # 15:00
SUN_END_HOUR = 18    # 18:00

# UI theme – neutral, readable, professional
BG_ROOT = "#f5f5f5"
BG_HEADER = "#2c3e50"
FG_HEADER = "#ecf0f1"
BG_CARD = "#ffffff"
BG_GRID_ALT = "#fafafa"
ACCENT = "#3498db"
ACCENT_HOVER = "#2980b9"
FONT_HEADER = ("Segoe UI", 11, "bold")
FONT_BODY = ("Segoe UI", 9)
FONT_SMALL = ("Segoe UI", 8)


def _solar_mw_for_interval(interval_index: int, peak_mw: float) -> float:
    """Return MW for this 5-min interval for a simple solar curve (sun out ~06:00–18:00)."""
    h = interval_index // 12
    if h < SUN_START_HOUR or h >= SUN_END_HOUR:
        return 0.0
    if SUN_PEAK_START <= h < SUN_PEAK_END:
        return round(peak_mw, 2)
    if SUN_START_HOUR <= h < SUN_PEAK_START:
        # Ramp up: 6->0, 7->~0.33, 8->~0.67, 9->1.0
        t = (h - SUN_START_HOUR) + (interval_index % 12) / 12.0
        total_slots = (SUN_PEAK_START - SUN_START_HOUR) * 12
        frac = min(1.0, t / total_slots) if total_slots else 1.0
        return round(peak_mw * frac, 2)
    # SUN_PEAK_END <= h < SUN_END_HOUR: ramp down
    t = (h - SUN_PEAK_END) + (interval_index % 12) / 12.0
    total_slots = (SUN_END_HOUR - SUN_PEAK_END) * 12
    frac = max(0.0, 1.0 - t / total_slots) if total_slots else 0.0
    return round(peak_mw * frac, 2)




def _parse_date(s: str) -> date | None:
    """Parse YYYY-MM-DD or DD/MM/YYYY."""
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _setup_styles(root: tk.Tk):
    """Apply a clean, modern ttk style set."""
    style = ttk.Style(root)
    try:
        style.theme_use("vista")
    except tk.TclError:
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
    style.configure("TFrame", background=BG_ROOT)
    style.configure("Card.TFrame", background=BG_CARD, relief="flat")
    style.configure("TLabel", background=BG_ROOT, font=FONT_BODY, foreground="#333333")
    style.configure("Card.TLabel", background=BG_CARD, font=FONT_BODY, foreground="#333333")
    style.configure("Header.TLabel", font=FONT_HEADER, foreground="#2c3e50")
    style.configure("TEntry", font=FONT_BODY, padding=4)
    style.configure("TButton", font=FONT_BODY, padding=(10, 6))
    style.configure(
        "Primary.TButton",
        font=FONT_BODY,
        padding=(14, 8),
    )
    style.map("Primary.TButton", background=[("active", ACCENT_HOVER)])


class SettingsDialog:
    """Modal dialog for Generator MRID, Participant MRID, Timezone."""

    def __init__(self, parent, on_save):
        self.on_save = on_save
        self.win = tk.Toplevel(parent)
        self.win.title("Settings")
        self.win.transient(parent)
        self.win.grab_set()
        self.win.geometry("420x220")
        self.win.configure(bg=BG_ROOT)
        self.win.resizable(True, False)
        cfg = config.load()
        outer = ttk.Frame(self.win, padding=20)
        outer.pack(fill=tk.BOTH, expand=True)
        ttk.Label(outer, text="Generator MRID:", style="Card.TLabel").grid(row=0, column=0, sticky=tk.W, pady=6)
        self.gen_mrid = ttk.Entry(outer, width=36)
        self.gen_mrid.grid(row=0, column=1, sticky=tk.EW, pady=6, padx=(12, 0))
        self.gen_mrid.insert(0, cfg.get("generator_mrid", ""))
        ttk.Label(outer, text="Participant MRID:", style="Card.TLabel").grid(row=1, column=0, sticky=tk.W, pady=6)
        self.part_mrid = ttk.Entry(outer, width=36)
        self.part_mrid.grid(row=1, column=1, sticky=tk.EW, pady=6, padx=(12, 0))
        self.part_mrid.insert(0, cfg.get("participant_mrid", ""))
        ttk.Label(outer, text="Timezone (e.g. +08:00):", style="Card.TLabel").grid(row=2, column=0, sticky=tk.W, pady=6)
        self.tz = ttk.Entry(outer, width=36)
        self.tz.grid(row=2, column=1, sticky=tk.EW, pady=6, padx=(12, 0))
        self.tz.insert(0, cfg.get("timezone", "+08:00"))
        outer.columnconfigure(1, weight=1)
        btn_f = ttk.Frame(outer)
        btn_f.grid(row=3, column=0, columnspan=2, pady=(16, 0))
        ttk.Button(btn_f, text="Cancel", command=self.win.destroy).pack(side=tk.RIGHT, padx=6)
        ttk.Button(btn_f, text="Save", command=self._save, style="Primary.TButton").pack(side=tk.RIGHT)
        self.win.protocol("WM_DELETE_WINDOW", self.win.destroy)

    def _save(self):
        config.save(
            generator_mrid=self.gen_mrid.get(),
            participant_mrid=self.part_mrid.get(),
            timezone=self.tz.get(),
        )
        self.on_save()
        self.win.destroy()


class NominationApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("Day Ahead Nomination")
        self.root.minsize(720, 520)
        self.root.geometry("900x600")
        self.root.configure(bg=BG_ROOT)
        _setup_styles(self.root)
        self.cfg = config.load()
        # Single table: 288 rows × (Interval | Day Ahead | RTD). One column each for DA and RTD (like Excel).
        self.da_entries: list[tk.Entry] = []   # 288 = Day Ahead (MW)
        self.rtd_entries: list[tk.Entry] = []   # 288 = RTD (MW), one column
        self._build_ui()
        self._bind_paste()

    def _header(self):
        """Top bar: title, date, Rev #, actions."""
        header = tk.Frame(self.root, bg=BG_HEADER, height=56)
        header.pack(fill=tk.X)
        header.pack_propagate(False)
        inner = tk.Frame(header, bg=BG_HEADER)
        inner.pack(fill=tk.BOTH, expand=True, padx=16, pady=10)
        tk.Label(
            inner, text="Day Ahead Nomination", bg=BG_HEADER, fg=FG_HEADER, font=("Segoe UI", 14, "bold"),
        ).pack(side=tk.LEFT, pady=2)
        tk.Label(inner, text="  |  ", bg=BG_HEADER, fg=FG_HEADER, font=FONT_BODY).pack(side=tk.LEFT)
        tk.Label(inner, text="Forecast date (nomination day):", bg=BG_HEADER, fg=FG_HEADER, font=FONT_SMALL).pack(side=tk.LEFT, padx=(0, 4))
        self.date_var = tk.StringVar()
        date_entry = tk.Entry(
            inner, textvariable=self.date_var, width=12, font=FONT_BODY, relief="flat", bd=0, highlightthickness=0,
            bg="#ffffff", fg="#333333", insertbackground="#333333",
        )
        date_entry.pack(side=tk.LEFT, padx=2, ipady=4, ipadx=6)
        tk.Button(
            inner, text="Tomorrow", font=FONT_SMALL, bg="#34495e", fg=FG_HEADER, activebackground="#3d566e",
            activeforeground=FG_HEADER, relief="flat", padx=8, pady=4, cursor="hand2", command=self._set_forecast_tomorrow,
        ).pack(side=tk.LEFT, padx=4)
        tk.Label(inner, text="Rev #:", bg=BG_HEADER, fg=FG_HEADER, font=FONT_SMALL).pack(side=tk.LEFT, padx=(12, 4))
        self.rev_var = tk.StringVar()
        rev_entry = tk.Entry(
            inner, textvariable=self.rev_var, width=5, font=FONT_BODY, relief="flat", bd=0, highlightthickness=0,
            bg="#ffffff", fg="#333333", insertbackground="#333333",
        )
        rev_entry.pack(side=tk.LEFT, padx=2, ipady=4, ipadx=4)
        btn_frame = tk.Frame(inner, bg=BG_HEADER)
        btn_frame.pack(side=tk.RIGHT)
        settings_btn = tk.Button(
            btn_frame, text="Settings", font=FONT_BODY, bg="#34495e", fg=FG_HEADER, activebackground="#3d566e",
            activeforeground=FG_HEADER, relief="flat", padx=12, pady=6, cursor="hand2", command=self._open_settings,
        )
        settings_btn.pack(side=tk.LEFT, padx=4)
        tk.Button(
            btn_frame, text="Load CSV", font=FONT_SMALL, bg="#34495e", fg=FG_HEADER,
            activebackground="#3d566e", activeforeground=FG_HEADER, relief="flat", padx=8, pady=6, cursor="hand2",
            command=self._load_csv_forecast,
        ).pack(side=tk.LEFT, padx=2)
        tk.Button(
            btn_frame, text="Download CSV template", font=FONT_SMALL, bg="#34495e", fg=FG_HEADER,
            activebackground="#3d566e", activeforeground=FG_HEADER, relief="flat", padx=8, pady=6, cursor="hand2",
            command=self._download_csv_template,
        ).pack(side=tk.LEFT, padx=2)
        tk.Button(
            btn_frame, text="Graph view", font=FONT_SMALL, bg="#34495e", fg=FG_HEADER,
            activebackground="#3d566e", activeforeground=FG_HEADER, relief="flat", padx=8, pady=6, cursor="hand2",
            command=self._show_graph_view,
        ).pack(side=tk.LEFT, padx=2)
        export_btn = tk.Button(
            btn_frame, text="Export XML", font=FONT_BODY, bg=ACCENT, fg="white", activebackground=ACCENT_HOVER,
            activeforeground="white", relief="flat", padx=14, pady=6, cursor="hand2", command=self._generate_xml,
        )
        export_btn.pack(side=tk.LEFT)

    def _right_panel(self, parent):
        """Right side: instructions, config summary. Table on the left is the preview."""
        card = tk.Frame(parent, bg=BG_CARD, padx=16, pady=16)
        card.pack(side=tk.RIGHT, fill=tk.Y, padx=(0, 12), pady=12)
        tk.Label(card, text="How to use", font=FONT_HEADER, bg=BG_CARD, fg="#2c3e50").pack(anchor=tk.W)
        steps = (
            "1. Set Forecast date (or click Tomorrow). Load Day Ahead from your forecasting tool: \"Load CSV\" (file with 288 MW values) or Ctrl+V paste — Day Ahead column updates automatically.\n"
            "2. Enter RTD (manual only) in the RTD column — your actual prediction for the day, per 5‑min.\n"
            "3. Click Export XML when ready (current time in header; Resource 06VISTASOL_G01, Participant ARECO_01)."
        )
        tk.Label(card, text=steps, font=FONT_SMALL, bg=BG_CARD, fg="#555", justify=tk.LEFT).pack(anchor=tk.W, pady=(8, 16))
        tk.Label(card, text="Current settings", font=("Segoe UI", 9, "bold"), bg=BG_CARD, fg="#2c3e50").pack(anchor=tk.W)
        self.settings_summary = tk.Label(
            card, text="Generator: —\nParticipant: —", font=FONT_SMALL, bg=BG_CARD, fg="#666", justify=tk.LEFT,
        )
        self.settings_summary.pack(anchor=tk.W, pady=4)
        self._refresh_settings_summary()
        tk.Label(card, text="Preview (effective MW = RTD overrides Day Ahead)", font=("Segoe UI", 9, "bold"), bg=BG_CARD, fg="#2c3e50").pack(anchor=tk.W, pady=(14, 4))
        tk.Label(
            card, text="Shows what will be exported. Click Refresh to update after editing.", font=FONT_SMALL, bg=BG_CARD, fg="#555",
        ).pack(anchor=tk.W)
        tk.Button(
            card, text="Refresh preview", font=FONT_SMALL, bg=BG_GRID_ALT, fg="#333", relief="flat",
            padx=8, pady=4, cursor="hand2", command=self._refresh_preview,
        ).pack(anchor=tk.W, pady=4)
        preview_frame = tk.Frame(card, bg=BG_CARD)
        preview_frame.pack(fill=tk.BOTH, expand=True, pady=4)
        self.preview_list = tk.Listbox(
            preview_frame, height=14, font=("Consolas", 8), bg="#fafafa", fg="#333", selectbackground=ACCENT,
            selectforeground="white", highlightthickness=0, activestyle="none",
        )
        preview_scroll = ttk.Scrollbar(preview_frame)
        self.preview_list.configure(yscrollcommand=preview_scroll.set)
        preview_scroll.configure(command=self.preview_list.yview)
        preview_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.preview_list.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self._refresh_preview()

    def _set_forecast_tomorrow(self):
        """Set forecast date to tomorrow so you can prepare next day's nomination."""
        tomorrow = date.today() + timedelta(days=1)
        self.date_var.set(tomorrow.strftime("%Y-%m-%d"))

    def _bind_paste(self):
        """Paste into Day Ahead grid: Ctrl+V fills from clipboard (288 values in order)."""
        self.root.bind("<Control-v>", self._on_paste)
        self.root.bind("<Control-V>", self._on_paste)

    def _on_paste(self, event=None):
        """Parse clipboard and fill Day Ahead column (288 values in order)."""
        try:
            raw = self.root.clipboard_get()
        except tk.TclError:
            return
        numbers = _parse_numbers_from_text(raw)
        if not numbers:
            return
        for i in range(min(len(numbers), INTERVALS_PER_DAY)):
            ent = self.da_entries[i]
            ent.delete(0, tk.END)
            v = numbers[i]
            ent.insert(0, str(round(v, 4)) if isinstance(v, float) else str(v))
        self._refresh_preview()
        if len(numbers) < INTERVALS_PER_DAY:
            messagebox.showinfo("Paste", f"Filled {len(numbers)} values into Day Ahead. Remaining cells left as-is.")

    def _refresh_settings_summary(self):
        cfg = config.load()
        gen = (cfg.get("generator_mrid") or "").strip() or config.DEFAULTS["generator_mrid"] or "—"
        part = (cfg.get("participant_mrid") or "").strip() or config.DEFAULTS["participant_mrid"] or "—"
        self.settings_summary.config(text=f"Generator: {gen}\nParticipant: {part}")

    def _refresh_preview(self):
        """Fill preview list with Interval and effective MW (RTD overrides Day Ahead)."""
        self.preview_list.delete(0, tk.END)
        for i in range(INTERVALS_PER_DAY):
            h = i // 12
            m = (i % 12 + 1) * 5
            label = f"{h:02d}:{m:02d}" if m < 60 else f"{h:02d}:60"
            try:
                da_val = float((self.da_entries[i].get() or "0").strip() or "0")
            except (ValueError, IndexError):
                da_val = 0.0
            try:
                rtd_val = float((self.rtd_entries[i].get() or "0").strip() or "0")
            except (ValueError, IndexError):
                rtd_val = 0.0
            effective = rtd_val if rtd_val != 0.0 else da_val
            self.preview_list.insert(tk.END, f"  {label}   →   {effective} MW")

    def _fill_solar_curve(self):
        """Fill the Day Ahead column with a simple solar curve (sun out ~06:00–18:00)."""
        try:
            peak = float((self.solar_peak_var.get() or "50").strip() or "50")
            peak = max(0.0, min(9999.0, peak))
        except ValueError:
            peak = 50.0
        for i in range(INTERVALS_PER_DAY):
            val = _solar_mw_for_interval(i, peak)
            self.da_entries[i].delete(0, tk.END)
            self.da_entries[i].insert(0, str(val))
        messagebox.showinfo("Solar curve", f"Filled Day Ahead with sun-out curve (peak {peak} MW, ~06:00–18:00).")

    def _mw_grid(self, parent):
        """Single table: 288 rows × 3 columns — Interval | Day Ahead (MW) | RTD (MW). Table is the preview. RTD = one column like Excel."""
        card = tk.Frame(parent, bg=BG_CARD, padx=12, pady=12)
        card.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(12, 0), pady=12)
        top_row = tk.Frame(card, bg=BG_CARD)
        top_row.pack(fill=tk.X, pady=(0, 8))
        tk.Label(top_row, text="Table: Interval | Day Ahead (MW) | RTD (MW) — paste into Day Ahead; RTD one column (like Excel)", font=FONT_HEADER, bg=BG_CARD, fg="#2c3e50").pack(side=tk.LEFT)
        solar_frame = tk.Frame(top_row, bg=BG_CARD)
        solar_frame.pack(side=tk.RIGHT)
        tk.Label(solar_frame, text="Solar:", font=FONT_SMALL, bg=BG_CARD, fg="#555").pack(side=tk.LEFT, padx=(12, 4))
        self.solar_peak_var = tk.StringVar(value="50")
        tk.Entry(solar_frame, textvariable=self.solar_peak_var, width=5, font=FONT_SMALL).pack(side=tk.LEFT, padx=2)
        tk.Button(solar_frame, text="Fill solar (Day Ahead)", font=FONT_SMALL, bg="#27ae60", fg="white", relief="flat", padx=8, pady=4, cursor="hand2", command=self._fill_solar_curve).pack(side=tk.LEFT)
        grid_container = tk.Frame(card, bg=BG_CARD)
        grid_container.pack(fill=tk.BOTH, expand=True)
        canvas = tk.Canvas(grid_container, bg=BG_CARD, highlightthickness=0)
        scrollbar = ttk.Scrollbar(grid_container)
        scrollable = tk.Frame(canvas, bg=BG_CARD)
        scrollable.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        cw = canvas.create_window((0, 0), window=scrollable, anchor=tk.NW)
        canvas.configure(yscrollcommand=scrollbar.set)
        scrollbar.configure(command=canvas.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        def _on_canvas_resize(event):
            canvas.itemconfig(cw, width=event.width)
        canvas.bind("<Configure>", _on_canvas_resize)

        def _on_mousewheel(event):
            canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")
        canvas.bind_all("<MouseWheel>", _on_mousewheel)

        # Headers: Interval | Day Ahead (MW) | RTD (MW)
        tk.Label(scrollable, text="Interval", font=("Segoe UI", 8, "bold"), bg="#e8f4fc", fg="#333", width=10).grid(row=0, column=0, padx=2, pady=1)
        tk.Label(scrollable, text="Day Ahead (MW)", font=("Segoe UI", 8, "bold"), bg="#e8f4fc", fg="#333", width=14).grid(row=0, column=1, padx=2, pady=1)
        tk.Label(scrollable, text="RTD (MW)", font=("Segoe UI", 8, "bold"), bg="#fff3e0", fg="#333", width=12).grid(row=0, column=2, padx=2, pady=1)

        for i in range(INTERVALS_PER_DAY):
            h = i // 12
            m = (i % 12 + 1) * 5
            label = f"{h:02d}:{m:02d}" if m < 60 else f"{h:02d}:60"
            row_bg = BG_GRID_ALT if (i % 2) == 0 else BG_CARD
            tk.Label(scrollable, text=label, font=FONT_SMALL, bg=row_bg, fg="#333", width=10).grid(row=i + 1, column=0, padx=2, pady=0)
            ent_da = tk.Entry(scrollable, width=10, font=FONT_SMALL)
            ent_da.grid(row=i + 1, column=1, padx=2, pady=0, ipady=2, ipadx=4)
            ent_da.insert(0, "0")
            ent_da.configure(bg="#fff")
            self.da_entries.append(ent_da)
            ent_rtd = tk.Entry(scrollable, width=10, font=FONT_SMALL)
            ent_rtd.grid(row=i + 1, column=2, padx=2, pady=0, ipady=2, ipadx=4)
            ent_rtd.insert(0, "0")
            ent_rtd.configure(bg="#fff")
            self.rtd_entries.append(ent_rtd)

    def _build_ui(self):
        self._header()
        content = tk.Frame(self.root, bg=BG_ROOT, padx=0, pady=0)
        content.pack(fill=tk.BOTH, expand=True)
        self._mw_grid(content)
        self._right_panel(content)

    def _open_settings(self):
        SettingsDialog(self.root, self._refresh_settings_summary)

    def _get_hourly_series(self):
        """Return (hours 0..23, day_ahead_hourly_avg, rtd_hourly_avg). Each hourly value = average of 12 intervals."""
        da = []
        rtd = []
        for i in range(INTERVALS_PER_DAY):
            try:
                da.append(float((self.da_entries[i].get() or "0").strip() or "0"))
            except (ValueError, IndexError):
                da.append(0.0)
            try:
                rtd.append(float((self.rtd_entries[i].get() or "0").strip() or "0"))
            except (ValueError, IndexError):
                rtd.append(0.0)
        da_hourly = []
        rtd_hourly = []
        for h in range(24):
            start = h * 12
            da_hourly.append(sum(da[start : start + 12]) / 12)
            rtd_hourly.append(sum(rtd[start : start + 12]) / 12)
        return list(range(24)), da_hourly, rtd_hourly

    def _show_graph_view(self):
        """Open a window with a line chart: Day Ahead vs RTD hourly (average MW per hour)."""
        win = tk.Toplevel(self.root)
        win.title("Day Ahead vs RTD — Hourly forecast")
        win.geometry("780x420")
        win.configure(bg=BG_ROOT)
        hours, da_hourly, rtd_hourly = self._get_hourly_series()
        max_mw = max(max(da_hourly or [0]), max(rtd_hourly or [0]), 1.0)
        # Canvas dimensions
        cw, ch = 720, 320
        margin_l, margin_r = 56, 24
        margin_t, margin_b = 28, 44
        plot_w = cw - margin_l - margin_r
        plot_h = ch - margin_t - margin_b

        canvas = tk.Canvas(win, width=cw, height=ch, bg="white", highlightthickness=0)
        canvas.pack(padx=12, pady=12)

        def x_pos(h):
            return margin_l + (h / 23.0) * plot_w if plot_w else margin_l

        def y_pos(mw):
            return margin_t + plot_h - (mw / max_mw) * plot_h if max_mw and plot_h else margin_t + plot_h

        # Grid and Y-axis labels
        for i in range(5):
            y = margin_t + (i / 4.0) * plot_h
            mw_val = max_mw * (1.0 - i / 4.0)
            canvas.create_line(margin_l, y, margin_l + plot_w, y, fill="#e0e0e0", width=1)
            canvas.create_text(margin_l - 8, y, text=f"{mw_val:.0f}", anchor=tk.E, font=("Segoe UI", 8), fill="#555")
        canvas.create_text(margin_l - 8, margin_t + plot_h + 12, text="0", anchor=tk.E, font=("Segoe UI", 8), fill="#555")
        # X-axis labels
        for h in [0, 6, 12, 18, 23]:
            x = x_pos(h)
            canvas.create_line(x, margin_t + plot_h, x, margin_t, fill="#e0e0e0", width=1)
            canvas.create_text(x, margin_t + plot_h + 14, text=f"{h:02d}:00", anchor=tk.N, font=("Segoe UI", 8), fill="#555")
        # Axes
        canvas.create_line(margin_l, margin_t, margin_l, margin_t + plot_h, fill="#333", width=2)
        canvas.create_line(margin_l, margin_t + plot_h, margin_l + plot_w, margin_t + plot_h, fill="#333", width=2)
        canvas.create_text(cw // 2, ch - 6, text="Hour", font=("Segoe UI", 9, "bold"), fill="#333")
        canvas.create_text(14, ch // 2, text="MW (avg)", font=("Segoe UI", 9, "bold"), fill="#333", angle=90)

        # Day Ahead line (blue)
        pts_da = [(x_pos(h), y_pos(da_hourly[h])) for h in hours]
        for j in range(len(pts_da) - 1):
            canvas.create_line(pts_da[j][0], pts_da[j][1], pts_da[j + 1][0], pts_da[j + 1][1], fill="#2980b9", width=2.5)
        # RTD line (orange)
        pts_rtd = [(x_pos(h), y_pos(rtd_hourly[h])) for h in hours]
        for j in range(len(pts_rtd) - 1):
            canvas.create_line(pts_rtd[j][0], pts_rtd[j][1], pts_rtd[j + 1][0], pts_rtd[j + 1][1], fill="#e67e22", width=2.5)

        # Legend
        legend_y = margin_t - 10
        canvas.create_line(margin_l, legend_y, margin_l + 24, legend_y, fill="#2980b9", width=3)
        canvas.create_text(margin_l + 30, legend_y, text="Day Ahead", anchor=tk.W, font=("Segoe UI", 9), fill="#333")
        canvas.create_line(margin_l + 120, legend_y, margin_l + 144, legend_y, fill="#e67e22", width=3)
        canvas.create_text(margin_l + 150, legend_y, text="RTD", anchor=tk.W, font=("Segoe UI", 9), fill="#333")

        tk.Label(win, text="Hourly average MW (12 × 5‑min intervals per hour).", font=FONT_SMALL, bg=BG_ROOT, fg="#555").pack(pady=(0, 8))

    def _download_csv_template(self):
        """Let user save a CSV template file (288 MW values, one per line) for the day-ahead forecast."""
        path = filedialog.asksaveasfilename(
            title="Save CSV template",
            defaultextension=".csv",
            initialfile="day_ahead_forecast_template.csv",
            filetypes=[("CSV", "*.csv"), ("Text", "*.txt"), ("All", "*.*")],
        )
        if not path:
            return
        lines = [
            "# Day Ahead forecast: 288 MW values, one per 5-min interval (00:05 to 24:00).",
            "# One value per line below. Replace zeros with your forecast MW. Commas or tabs also work.",
            "",
        ]
        for _ in range(INTERVALS_PER_DAY):
            lines.append("0")
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write("\n".join(lines))
        except OSError as e:
            messagebox.showerror("Save error", f"Could not save file:\n{e}")
            return
        messagebox.showinfo("Template saved", f"Saved to:\n{path}\n\nFill in 288 MW values (one per line, or comma/tab separated), then use Load CSV.")

    def _load_csv_forecast(self):
        """Open file dialog; load CSV (or any text) with 288 numbers into Day Ahead column; table updates automatically."""
        path = filedialog.askopenfilename(
            title="Select forecast file (CSV or text with 288 MW values)",
            filetypes=[("CSV / Text", "*.csv;*.txt"), ("CSV", "*.csv"), ("All", "*.*")],
        )
        if not path:
            return
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError as e:
            messagebox.showerror("Read error", f"Could not read file:\n{e}")
            return
        numbers = _parse_numbers_from_text(text)
        if not numbers:
            messagebox.showwarning("No numbers", "No numeric values found in the file. Use comma, tab, or newline-separated numbers (288 MW values).")
            return
        for i in range(min(len(numbers), INTERVALS_PER_DAY)):
            self.da_entries[i].delete(0, tk.END)
            v = numbers[i]
            self.da_entries[i].insert(0, str(round(v, 4)) if isinstance(v, float) else str(v))
        self._refresh_preview()
        messagebox.showinfo("Loaded", f"Loaded {min(len(numbers), INTERVALS_PER_DAY)} values into Day Ahead. Table updated.")

    def _generate_xml(self):
        s = self.date_var.get().strip()
        fd = _parse_date(s)
        if fd is None:
            messagebox.showerror("Invalid date", "Enter forecast date as YYYY-MM-DD (e.g. 2026-02-21).")
            return
        cfg = config.load()
        gen = (cfg.get("generator_mrid") or "").strip() or config.DEFAULTS.get("generator_mrid", "06VISTASOL_G01")
        part = (cfg.get("participant_mrid") or "").strip() or config.DEFAULTS.get("participant_mrid", "ARECO_01")
        # RTD (Real Time Dispatch) always overrides Day Ahead: per interval, use RTD if non-zero, else Day Ahead
        mw_list = []
        for i in range(INTERVALS_PER_DAY):
            try:
                da_val = float((self.da_entries[i].get() or "0").strip() or "0")
            except ValueError:
                da_val = 0.0
            try:
                rtd_val = float((self.rtd_entries[i].get() or "0").strip() or "0")
            except ValueError:
                rtd_val = 0.0
            mw_list.append(rtd_val if rtd_val != 0.0 else da_val)
        data = build_raw_bid_set(
            forecast_date=fd,
            mw_by_interval=mw_list,
            generator_mrid=gen,
            participant_mrid=part,
            timezone_str=cfg.get("timezone", "+08:00"),
            name=gen,
            source=cfg.get("source", "Default"),
        )
        out_path = write_raw_bid_set(data, fd)
        messagebox.showinfo(
            "XML generated",
            f"Saved to:\n{out_path}\n\nYou can open the output folder to upload the file to IEMOP.",
        )
        if messagebox.askyesno("Open folder?", "Open output folder now?"):
            import os
            import subprocess
            path = str(out_path.resolve())
            if os.name == "nt":
                os.startfile(os.path.dirname(path))
            else:
                subprocess.run(["xdg-open", os.path.dirname(path)], check=False)

    def run(self):
        self.root.mainloop()


def main():
    (config.PROJECT_ROOT / "output").mkdir(parents=True, exist_ok=True)
    app = NominationApp()
    app.run()


if __name__ == "__main__":
    main()
