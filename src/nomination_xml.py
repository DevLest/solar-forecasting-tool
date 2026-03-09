"""
Serialize RawBidSet structure to XML and write to output/RawBidSet_YYYYMMDD.xml.
Emits m: prefix and schema location per NMMS spec.
"""
from pathlib import Path
from datetime import date

from . import config

NS = "http://pemc/soa/RawBidSet.xsd"
XSI_NS = "http://www.w3.org/2001/XMLSchema-instance"
SCHEMA_LOCATION = "http://pemc/soa/RawBidSet.xsd RawBidSet.xsd"


def _escape(s: str) -> str:
    if s is None:
        return ""
    s = str(s)
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _build_xml_string(data: dict) -> str:
    """Build full XML document with m: prefix on all elements."""
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<m:RawBidSet xmlns:m="{NS}" xmlns:xsi="{XSI_NS}" xsi:schemaLocation="{SCHEMA_LOCATION}">',
    ]
    header = data.get("MessageHeader") or {}
    lines.append(" <m:MessageHeader>")
    lines.append(f"  <m:TimeDate>{_escape(header.get('TimeDate'))}</m:TimeDate>")
    lines.append(f"  <m:Source>{_escape(header.get('Source', 'Default'))}</m:Source>")
    lines.append(" </m:MessageHeader>")

    gen_bid = (data.get("MessagePayload") or {}).get("GeneratingBid") or {}
    lines.append(" <m:MessagePayload>")
    lines.append("  <m:GeneratingBid>")
    if gen_bid.get("name"):
        lines.append(f"   <m:name>{_escape(gen_bid['name'])}</m:name>")
    lines.append(f"   <m:startTime>{_escape(gen_bid.get('startTime'))}</m:startTime>")
    lines.append(f"   <m:stopTime>{_escape(gen_bid.get('stopTime'))}</m:stopTime>")
    lines.append("   <m:RegisteredGenerator>")
    lines.append(f"    <m:mrid>{_escape(gen_bid.get('RegisteredGenerator', {}).get('mrid'))}</m:mrid>")
    lines.append("   </m:RegisteredGenerator>")
    lines.append("   <m:MarketParticipant>")
    lines.append(f"    <m:mrid>{_escape(gen_bid.get('MarketParticipant', {}).get('mrid'))}</m:mrid>")
    lines.append("   </m:MarketParticipant>")
    lines.append("   <m:ProductBid>")
    for nom in (gen_bid.get("ProductBid") or {}).get("Nomination") or []:
        lines.append("    <m:Nomination>")
        lines.append(f"     <m:timeIntervalStart>{_escape(nom.get('timeIntervalStart'))}</m:timeIntervalStart>")
        lines.append(f"     <m:timeIntervalEnd>{_escape(nom.get('timeIntervalEnd'))}</m:timeIntervalEnd>")
        for mm in nom.get("minuteMW") or []:
            lines.append("     <m:minuteMW>")
            lines.append(f"      <m:minuteOfHour>{_escape(mm.get('minuteOfHour'))}</m:minuteOfHour>")
            lines.append(f"      <m:quantity>{_escape(mm.get('quantity'))}</m:quantity>")
            lines.append("     </m:minuteMW>")
        lines.append("    </m:Nomination>")
    lines.append("   </m:ProductBid>")
    lines.append("  </m:GeneratingBid>")
    lines.append(" </m:MessagePayload>")
    lines.append("</m:RawBidSet>")
    return "\n".join(lines)


def write_raw_bid_set(data: dict, forecast_date: date) -> Path:
    """
    Write RawBidSet XML to output/RawBidSet_YYYYMMDD.xml.
    Creates output/ if missing. Returns path to written file.
    """
    out_dir = config.PROJECT_ROOT / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = f"RawBidSet_{forecast_date:%Y%m%d}.xml"
    path = out_dir / filename
    xml_str = _build_xml_string(data)
    with open(path, "w", encoding="utf-8") as f:
        f.write(xml_str)
    return path
