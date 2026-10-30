// Types of the sign-up choices (POST /auth/register and PATCH /me), from src/constants/onboarding.ts.

import type {
  INVESTMENT_FOCUS_CODES,
  INVESTMENT_SECTOR_CODES,
  INVESTMENT_STYLE_CODES,
  JOB_PROFILE_CODES,
  PREFERENCE_TYPES,
  RISK_LEVEL_CODES,
} from '../constants/onboarding';

export type JobProfileCode = (typeof JOB_PROFILE_CODES)[number];
export type InvestmentFocusCode = (typeof INVESTMENT_FOCUS_CODES)[number];
export type RiskLevelCode = (typeof RISK_LEVEL_CODES)[number];
export type InvestmentStyleCode = (typeof INVESTMENT_STYLE_CODES)[number];
export type InvestmentSectorCode = (typeof INVESTMENT_SECTOR_CODES)[number];

/** A request field of the preferences (focus, risk, style, sector). */
export type PreferenceField = keyof typeof PREFERENCE_TYPES;
/** How a preference list is stored (app.user_preferences.type). */
export type PreferenceType = (typeof PREFERENCE_TYPES)[PreferenceField];

/** Sign-up step 3 as the API takes and returns it: the chosen codes of each list. */
export interface Preferences {
  focus: InvestmentFocusCode[];
  risk: RiskLevelCode[];
  style: InvestmentStyleCode[];
  sector: InvestmentSectorCode[];
}
