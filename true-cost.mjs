// TOKENHOURS Live · true-cost — the single number: what an hour of your build
// ACTUALLY costs. Token spend alone undercounts; this folds in the time you worked
// and the subscriptions a token meter can't see. Local math over local data only.
//
//   trueCostPerHour = tokenSpendToday / hoursWorkedToday
//                   + subscriptionCostThisMonth / hoursWorkedThisBillingPeriod
//
//   import { computeTrueCost } from "./true-cost.mjs"
//   computeTrueCost({ tokenSpendToday: 4.12 })  // meter supplies today's token $

import { getWorked } from "./heartbeat.mjs";
import { monthlyTotal, subsCostPerHour } from "./subscriptions.mjs";

const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; };

export function computeTrueCost({ tokenSpendToday = 0 } = {}) {
  const { hoursToday, hoursSince } = getWorked();
  const hoursThisMonth = hoursSince(monthStart());
  const tokenPerHour = hoursToday > 0 ? tokenSpendToday / hoursToday : 0;
  const subsMonthly = monthlyTotal();
  const subsPerHour = subsCostPerHour(hoursThisMonth);
  const trueCostPerHour = tokenPerHour + subsPerHour;
  return {
    trueCostPerHour, tokenPerHour, subsPerHour,
    hoursToday, hoursThisMonth, subsMonthly, tokenSpendToday,
    // a readout is only meaningful once some time has actually been tracked
    ready: hoursToday > 0.02,
  };
}
