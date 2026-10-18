// Singapore public holidays, from MOM's "Public Holidays for 2026" and "Public Holidays for 2027"
// datasets on data.gov.sg (d_149b61ad0a22f61c09dc80f2df5bbec8, d_0ba69fc6d56717ff0bf8083c6af3bb84),
// fetched 2026-10-18. Add the next year when MOM publishes it; dates outside the covered years
// make cost estimates unavailable rather than guessing.

export const HOLIDAYS_SOURCE = "MOM public holidays via data.gov.sg, fetched 2026-10-18";
export const HOLIDAY_YEARS = [2026, 2027] as const;

export const PUBLIC_HOLIDAYS: ReadonlySet<string> = new Set([
  "2026-01-01", "2026-02-17", "2026-02-18", "2026-03-21", "2026-04-03", "2026-05-01", "2026-05-27",
  "2026-05-31", "2026-06-01", "2026-08-09", "2026-08-10", "2026-11-08", "2026-11-09", "2026-12-25",
  "2027-01-01", "2027-02-06", "2027-02-07", "2027-02-08", "2027-03-10", "2027-03-26", "2027-05-01",
  "2027-05-17", "2027-05-20", "2027-08-09", "2027-10-28", "2027-12-25"
]);

export const holidaysCover = (isoDate: string) => (HOLIDAY_YEARS as readonly number[]).includes(Number(isoDate.slice(0, 4)));
