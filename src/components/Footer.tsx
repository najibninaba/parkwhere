import { HOLIDAYS_SOURCE } from "../../shared/holidays";
import { TARIFF_SOURCE, TARIFF_URL } from "../../shared/tariff";

export function Footer({ registryFetchedAt }: { registryFetchedAt: string | null }) {
  const registryDate = registryFetchedAt ? new Date(registryFetchedAt).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" }) : null;
  return (
    <footer className="footer">
      <h2 className="label">Sources</h2>
      <p>
        Contains information from{" "}
        <a href="https://data.gov.sg/datasets/d_ca933a644e55d34fe21f28b8052fac63/view" target="_blank" rel="noopener noreferrer">Carpark Availability</a> (live) and{" "}
        <a href="https://data.gov.sg/datasets/d_23f946fa557947f93a8043bbef41dd09/view" target="_blank" rel="noopener noreferrer">HDB Carpark Information</a>
        {registryDate ? ` (accessed ${registryDate})` : ""} from data.gov.sg, made available under the terms of the{" "}
        <a href="https://data.gov.sg/open-data-licence" target="_blank" rel="noopener noreferrer">Singapore Open Data Licence version 1.0</a>.
      </p>
      <p>
        Mall and URA carpark counts contain information from{" "}
        <a href="https://datamall.lta.gov.sg/content/datamall/en/dynamic-data.html" target="_blank" rel="noopener noreferrer">Car Park Availability</a> accessed from LTA DataMall, made available under the terms of the{" "}
        <a href="https://datamall.lta.gov.sg/content/datamall/en/SingaporeOpenDataLicence.html" target="_blank" rel="noopener noreferrer">Singapore Open Data Licence version 1.0</a>.
      </p>
      <p>
        Prices follow <a href={TARIFF_URL} target="_blank" rel="noopener noreferrer">{TARIFF_SOURCE}</a> and {HOLIDAYS_SOURCE}. Estimates assume one continuous stay in a regular (non-season) lot; the charge at the gantry is what counts.
      </p>
      <p>
        Maps © OneMap contributors, Singapore Land Authority. ParkWhere is an independent project and isn't affiliated with or endorsed by HDB, LTA, URA, SLA or GovTech.
      </p>
    </footer>
  );
}
