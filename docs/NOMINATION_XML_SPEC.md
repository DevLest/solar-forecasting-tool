# Day Ahead Nomination XML – Spec Reference

This app produces **RawBidSet** XML for IEMOP (Independent Electricity Market Operator of the Philippines) submission, using the **Nomination** pattern (Day Ahead MW per 5‑minute interval). It replaces the Excel workflow in **For Upload Nomination_2025.xlsm** with a local app that keeps the same data layout and flow.

**In this project:**
- `schemas/RawBidSet.xsd` – schema (copy from NMMS guide)
- `schemas/nomination_sample.xml` – template for nomination-only submission

**Full NMMS guide (reference):** `c:\Users\leste\Downloads\NMMS MPI XML Guide_v2\`
- RawBidSet.xsd, nomination_sample.xml, **NMMS MPI XML Bid Submission Guide_v2.pdf**
- Other samples: generation_offer_sample.xml, load_offer_sample.xml, etc. (not used for nomination-only Day Ahead)

---

## Defaults (always in XML export per RawBidSet.xsd)

- **Resource Name (RegisteredGenerator/mrid):** `06VISTASOL_G01` (default; configurable in Settings)
- **Market Participant (MarketParticipant/mrid):** `ARECO_01` (default; configurable in Settings)

Both are **always included** in the generated XML file per RawBidSet.xsd. The app uses these defaults unless changed in Settings; the Excel sheet uses the same values in the “Change Resource name” / Market Participant area.

---

## Flow of the day (aligned with Excel and user workflow)

All values are **megawatt (MW)** data.

1. **Paste forecast** – Paste the forecasted data for the whole day (from your forecasting tool, predicted yesterday). No need to edit after paste.
2. **Day Ahead** – After pasting, the values are **automatically applied** to the Day Ahead column (24 hours × 12 intervals = 288 values, same as the Excel “Day Ahead” 24×12 grid).
3. **RTD (manual)** – For the **next hour**, enter your actual prediction for the current time. RTD is **per 5 minutes** (288 values); you add values **every hour** by filling all 12 cells for that hour at once. The **NOM Forecast** table (Preview) updates automatically as you type.
4. **Export** – When done, click **Export** to export the data **based on the current time** (MessageHeader/TimeDate = time of export).
5. **XML file** – Export generates the RawBidSet XML file (e.g. `output/RawBidSet_YYYYMMDD.xml`) ready for IEMOP upload.

---

## Alignment with Excel (For Upload Nomination_2025.xlsm)

| Excel | This app |
|-------|----------|
| **Delivery Date** (input target) | **Forecast date** (nomination day) |
| **Day-Ahead Plant Generation Schedule** – 24 rows (HR 1–24) × 12 intervals (05–60 min) | **Day Ahead (MW)** – 24×12 grid (H00–H23, 5–60 min) |
| RTD / manual prediction (per 5‑min in Excel) | **RTD (MW)** – 24×12 grid; fill 12 cells per hour when you predict for that hour |
| Flattened list: INTERVAL, RTD (MW), DAY AHEAD | **Preview before XML** = NOM Forecast table (Interval \| Day Ahead \| RTD) |
| Rev # | **Rev #** in header |
| Resource name 06VISTASOL_G01, Market Participant ARECO_01 | **Settings** defaults; always written to XML |

---

## Namespace and root

- **Namespace:** `http://pemc/soa/RawBidSet.xsd`
- **Root element:** `m:RawBidSet`
- **Schema location:** `xsi:schemaLocation="http://pemc/soa/RawBidSet.xsd RawBidSet.xsd"`

---

## Structure used for Day Ahead nomination

1. **MessageHeader** (optional but recommended)
   - `m:TimeDate` – xs:dateTime (e.g. `2026-03-08T01:26:51.000Z` or with offset)
   - `m:Source` – string (e.g. `Default`)

2. **MessagePayload** → single **GeneratingBid**
   - `m:name` – optional, max 32 chars (e.g. generator ID like `06VISTASOL_G01`)
   - `m:startTime` / `m:stopTime` – xs:dateTime, **required** (trading day range, e.g. `2026-02-21T00:00:00.000+08:00` to `2026-02-22T00:00:00.000+08:00`)
   - `m:RegisteredGenerator` / `m:mrid` – **required**, 1–32 chars
   - `m:MarketParticipant` / `m:mrid` – **required**, 1–32 chars
   - **ProductBid** – one only, with **Nomination** elements only (no MarketProduct, no BidSchedule for nomination)

3. **ProductBid** (nomination-only)
   - **Nomination** – 1 to 24 (one per hour)
     - `m:timeIntervalStart` / `m:timeIntervalEnd` – xs:dateTime (hour boundaries, e.g. `2026-02-21T00:00:00.000+08:00` / `2026-02-21T01:00:00.000+08:00`)
     - **minuteMW** – 0..n (typically 12 per hour: minuteOfHour 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60)
       - `m:minuteOfHour` – integer (5, 10, …, 60)
       - `m:quantity` – float (MW)

---

## Date/time format

- Use **xs:dateTime**: `yyyy-mm-ddThh24:mi:ss.000+08:00` (Philippines) or `...Z` for UTC.
- Example: `2026-02-21T00:00:00.000+08:00` for start of trading day in +08:00.

---

## Schema constraints (from RawBidSet.xsd)

- **name / description / mrid:** max length 32, min 1.
- **GeneratingBid:** startTime, stopTime, RegisteredGenerator, MarketParticipant, at least one ProductBid are required.
- **Nomination:** timeIntervalStart and timeIntervalEnd required; hourMW optional; minuteMW optional but we use it for 5‑min quantities.
- **ProductBid_G:** up to 24 BidSchedules and up to 24 Nominations; for nomination-only we use only Nominations.

---

## Technical flow (how the app builds XML)

- User sets **forecast date** (Delivery Date) and **Rev #**. Day Ahead (288 MW) is entered via paste or solar curve into the 24×12 grid; RTD (288 MW) is optional manual input per 5‑min (typically filled one hour at a time).
- App flattens Day Ahead grid → 288 values in order 00:05 … 24:00, groups by hour → 24 Nominations, each with 12 minuteMW (5, 10, …, 60).
- App sets **MessageHeader** (TimeDate = **current time at export**, Source = Default), one **GeneratingBid** (name, startTime, stopTime, **RegisteredGenerator mrid**, **MarketParticipant mrid** from config, default 06VISTASOL_G01 / ARECO_01), one ProductBid with 24 Nominations.
- Output file: **RawBidSet** XML (e.g. `output/RawBidSet_YYYYMMDD.xml`) ready for IEMOP upload (Web Service or XML upload per MMS guide).
