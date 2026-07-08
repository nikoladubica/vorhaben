// Single source of truth for how each compensation model maps to form fields (BUSINESS_LOGIC
// §2). The project form consumes ONLY this file for model→field logic, so adding a model later
// means editing this one file — mirroring the server's single-constants-file rule.

import type { CompensationModel } from '../types';

export interface CompensationConfig {
  // Human label for the model in the segmented control.
  label: string;
  // When set, the model shows an amount field with this label + placeholder.
  amountLabel?: string;
  amountPlaceholder?: string;
  // When set (commission/variable), no amount field renders; the hint explains why.
  hint?: string;
}

// Ordered to match server/src/domain/constants.ts COMPENSATION_MODELS.
export const COMPENSATION_CONFIG: Record<CompensationModel, CompensationConfig> = {
  hourly: {
    label: 'Hourly',
    amountLabel: 'Rate per hour',
    amountPlaceholder: '0.00',
  },
  salary_monthly: {
    label: 'Monthly salary',
    amountLabel: 'Amount per month',
    amountPlaceholder: '0.00',
  },
  salary_biweekly: {
    label: 'Bi-weekly',
    amountLabel: 'Amount per 2 weeks',
    amountPlaceholder: '0.00',
  },
  salary_weekly: {
    label: 'Weekly',
    amountLabel: 'Amount per week',
    amountPlaceholder: '0.00',
  },
  fixed: {
    label: 'Fixed, one-time',
    amountLabel: 'Total amount',
    amountPlaceholder: '0.00',
  },
  commission: {
    label: 'Commission',
    hint: 'Income for this model is recorded as individual entries.',
  },
  variable: {
    label: 'Variable',
    hint: 'Income for this model is recorded as individual entries.',
  },
};

// The models in display order — drives the segmented control and payload logic.
export const COMPENSATION_MODELS = Object.keys(
  COMPENSATION_CONFIG,
) as CompensationModel[];

// Whether a model carries a rate/amount at all (false for commission/variable).
export function modelHasAmount(model: CompensationModel): boolean {
  return COMPENSATION_CONFIG[model].amountLabel !== undefined;
}
