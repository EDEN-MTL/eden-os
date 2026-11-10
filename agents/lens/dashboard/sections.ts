/** How the KPI cards are grouped on the dashboard, in the order the brief lists them. */
import { MetricKey } from "./definitions";

export interface Section {
  id: string;
  title: string;
  keys: MetricKey[];
}

export const SECTIONS: Section[] = [
  { id: "meta", title: "Meta ads performance", keys: ["spend", "impressions", "reach", "clicks", "ctr", "cpc", "metaLeads", "cpl"] },
  {
    id: "appointments",
    title: "Appointment performance",
    keys: ["appointmentsBooked", "costPerAppointment", "confirmedAppointments", "attendedAppointments", "noShowAppointments", "showUpRate", "costPerAttended"],
  },
  {
    id: "conversion",
    title: "Lead conversion",
    keys: ["totalLeads", "qualifiedLeads", "unqualifiedLeads", "leadToAppointment", "appointmentToSale", "closedDeals"],
  },
  {
    id: "revenue",
    title: "Revenue and profitability",
    keys: ["revenueAttributed", "spend", "otherCosts", "roas", "roi", "costPerClosedDeal"],
  },
  {
    id: "attribution",
    title: "Closed-deal attribution",
    keys: ["attributedLeads", "appointmentsBookedAttributed", "closedDealsAttributed", "revenueAll"],
  },
];
