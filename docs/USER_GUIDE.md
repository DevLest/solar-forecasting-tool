# Day Ahead Nomination – Step-by-step guide

How to input a forecast for **tomorrow** (or any day ahead) and export the XML for IEMOP.

---

## Step 1: Open the app

- Double-click **Run Day Ahead Nomination.bat** (in the project folder), or  
- Run in a terminal: `python main_nomination.py`

The Day Ahead Nomination window opens with:
- **Forecast date** (nomination day)
- **Rev #**
- A grid: **Day Ahead (MW)** and **RTD (MW)** (24 hours × 12 intervals each)
- **Preview** and **Export XML** on the right

---

## Step 2: Set the forecast date (target delivery day)

- In the header, find **Forecast date (nomination day):**.
- **For tomorrow:** click the **Tomorrow** button. The date field will show tomorrow’s date (e.g. `2026-03-10`).
- **For another day:** type the date in **YYYY-MM-DD** (e.g. `2026-03-15`) in the date field.

This is the **delivery date** the nomination is for (same as “Delivery Date” in the Excel sheet).

---

## Step 3: (Optional) Set Rev #

- Enter the revision number in **Rev #** (e.g. `1`). This is for your tracking; it is not written into the XML.

---

## Step 4: Put the Day Ahead forecast into the grid

You need **288 MW values** for the whole day (one per 5‑minute interval: 00:05, 00:10, … 23:55, 24:00).

### Option A: Paste from your forecasting tool (recommended)

1. In your **forecasting tool**, export or copy the 288 MW values for the **same day** you set in Step 2 (e.g. tomorrow).
2. Copy them to the clipboard (e.g. one value per line, or separated by tabs/commas).
3. In the nomination app, click once in the **left (Day Ahead)** area or anywhere in the main grid so the window has focus.
4. Press **Ctrl+V** (Paste).
5. The app fills the **Day Ahead** columns in order:  
   Hour 00 (5, 10, …, 60 min), then Hour 01, …, then Hour 23.  
   No need to edit after paste unless you want to change a value.

If you paste fewer than 288 numbers, only the first cells are filled; the rest stay as they were (e.g. 0).

### Option B: Use “Fill solar (Day Ahead)” for a quick curve

- If you don’t have a forecast to paste, you can use **Fill solar (Day Ahead)**:
  - Enter a **peak MW** (e.g. `50`) in the Solar box.
  - Click **Fill solar (Day Ahead)**.  
  The app fills the Day Ahead grid with a simple solar curve (roughly 06:00–18:00). You can then adjust any cell manually.

---

## Step 5: (Optional) Fill RTD for the next hour

- **RTD (MW)** is for your real-time prediction for the **next hour** (manual input).
- Find the **hour row** (e.g. **H08** for 08:00–09:00) in the **RTD** section (right side of the grid, after the gray separator).
- Fill all **12 cells** for that hour (5, 10, 15, …, 60 min) with your predicted MW values.
- The **Preview (NOM Forecast)** list on the right updates as you type.

You can fill RTD for one hour and leave the rest at 0, or fill more hours as needed.

---

## Step 6: Check the preview

- In the right panel, look at **Preview before XML**.
- It shows all 288 intervals with **Interval**, **Day Ahead**, and **RTD**.
- Click **Refresh preview** if you changed values and the list didn’t update.
- Confirm that Day Ahead (and RTD, if you entered it) look correct for the forecast date you set.

---

## Step 7: Export the XML

- When everything is ready, click **Export XML** in the header.
- The app generates a file using **the current time** in the message header.
- File location: **output/RawBidSet_YYYYMMDD.xml** (the date in the filename is the **forecast date** you set in Step 2).
- The XML always includes **Resource 06VISTASOL_G01** and **Participant ARECO_01** by default (you can change these in **Settings**).

You can then upload this file to IEMOP according to their process.

---

## Quick checklist for “forecast for tomorrow”

| # | Action |
|---|--------|
| 1 | Open the app. |
| 2 | Click **Tomorrow** (or type tomorrow’s date in YYYY-MM-DD). |
| 3 | Copy 288 MW values from your forecasting tool for that day. |
| 4 | In the app, press **Ctrl+V** to paste into Day Ahead. |
| 5 | (Optional) Fill RTD for the next hour. |
| 6 | Check **Preview**, then click **Export XML**. |
| 7 | Use the file in **output/RawBidSet_YYYYMMDD.xml** for IEMOP. |

---

## Tips

- **Paste order:** Values are applied in order: first 12 → Hour 00 (5–60 min), next 12 → Hour 01, …, last 12 → Hour 23.
- **Settings:** Use **Settings** in the header to change Resource name or Market Participant if needed; they are always written to the XML.
- **Forecast date:** The **Forecast date** is the day the nomination is for. “Tomorrow” sets it to the next calendar day so you can prepare the next day’s submission.
