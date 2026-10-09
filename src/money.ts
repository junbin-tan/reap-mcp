import { Decimal } from "decimal.js";
import { AppError } from "./errors.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export interface Money { amount: string; currency: string }
const currencies = new Set(Intl.supportedValuesOf("currency"));

export function currencyDigits(currency: string): number {
  if (!currencies.has(currency)) throw new AppError("UPSTREAM_CONTRACT_ERROR", "An unsupported ISO currency was returned.");
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function money(raw: string, currency: string, unit: "major" | "minor" = "major"): Money {
  if (!/^-?(0|[1-9]\d{0,20})(\.\d{1,12})?$/.test(raw)) throw new AppError("UPSTREAM_CONTRACT_ERROR", "The provider returned an invalid monetary amount.");
  const digits = currencyDigits(currency);
  const value = new Decimal(raw);
  if (unit === "minor" && !value.isInteger()) throw new AppError("UPSTREAM_CONTRACT_ERROR", "Minor-unit amounts must be integers.");
  const major = unit === "minor" ? value.div(new Decimal(10).pow(digits)) : value;
  if (!major.isFinite() || major.decimalPlaces() > digits) throw new AppError("UPSTREAM_CONTRACT_ERROR", "The amount has unconfirmed currency precision; no rounding was applied.");
  return { amount: major.toFixed(digits), currency };
}

export function withinBudget(amount: Money, cap: string, budget: string | null): boolean {
  const value = new Decimal(amount.amount);
  return !value.isNegative() && value.lte(cap) && (budget === null || value.lte(budget));
}

export function equalMoney(left: Money, right: Money): boolean {
  return left.currency === right.currency && new Decimal(left.amount).eq(right.amount);
}
