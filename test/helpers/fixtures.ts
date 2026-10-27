// Rows shaped like the database returns them, and request bodies, for the HTTP tests.

import { TEST_USERS } from './fakeSupabase';

export const COMPANY_A = '8f1c2b9e-0000-4000-8000-00000000000a';
export const COMPANY_B = '8f1c2b9e-0000-4000-8000-00000000000b';
export const REVIEW_ID = '5d2a0000-0000-4000-8000-000000000001';
/** Evidence objects in the review-evidence bucket, in the Prive test user's folder. */
export const EVIDENCE_PATH = `${TEST_USERS.prive.id}/statement.pdf`;
export const EVIDENCE_PATH_2 = `${TEST_USERS.prive.id}/email.png`;

/** A row of the company_cards view. */
export function companyCardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: COMPANY_A,
    slug: 'astra-mutuals',
    name: 'Astra Mutuals',
    description: 'Mutual fund house.',
    asset_class: 'MF',
    country: 'IN',
    logo_url: null,
    verified: true,
    created_at: '2026-01-10T00:00:00Z',
    tags: ['Large CAP Stocks', 'ETF', 'IPO'],
    review_count: 12,
    score: 4.56,
    relevance: 11.7,
    avg_transparency: 4.1,
    avg_responsiveness: 3.9,
    avg_ease_of_process: 4.2,
    avg_trustworthiness: 4.4,
    avg_overall_satisfaction: 4.5,
    positive_pct: 66.67,
    neutral_pct: 16.67,
    negative_pct: 16.66,
    dominant_sentiment: 'Positive',
    resolved_pct: 50,
    in_progress_pct: 25,
    unresolved_pct: 16.67,
    not_contacted_pct: 8.33,
    dominant_resolution: 'RESOLVED',
    reviews_30d: 3,
    score_change_12m: 0.4,
    last_review_at: '2026-10-20T00:00:00Z',
    ...overrides,
  };
}

/** A row of the review_feed view (published reviews). */
export function reviewFeedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    company_id: COMPANY_A,
    country: 'IN',
    asset_class: 'MF',
    product_scheme: 'Bluechip',
    investment_year: 2024,
    investment_status: 'CURRENTLY_INVESTED',
    sentiment: 'Positive',
    detailed_review: 'Payouts always arrived on time.',
    mixed_review: null,
    negative_description: null,
    reinvest_status: 'YES',
    m_transparency: 4,
    m_responsiveness: 5,
    m_ease_of_process: 4,
    m_trustworthiness: 4,
    m_overall_satisfaction: 5,
    avg_rating: 4.4,
    resolution_status: 'RESOLVED',
    resolution_bucket: 'RESOLVED',
    follow_up_note: null,
    display_mode: 'INITIALS',
    author_name: 'S. M.',
    appreciations: ['TIMELY_PAYOUTS'],
    concerns: [],
    contact_statuses: [],
    created_at: '2026-10-01T00:00:00Z',
    published_at: '2026-10-02T00:00:00Z',
    ...overrides,
  };
}

/** The reviewer's own review, as selected with its company, tags, evidence and events. */
export function ownReviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    receipt_no: 'GIG-RV-2026-000042',
    user_id: TEST_USERS.prive.id,
    author_name: 'Shreya Mehta',
    company_id: COMPANY_A,
    country: 'IN',
    asset_class: 'MF',
    product_scheme: 'Bluechip',
    investment_year: 2024,
    investment_status: 'CURRENTLY_INVESTED',
    sentiment: 'Negative',
    detailed_review: null,
    mixed_review: null,
    negative_description: 'Redemption took 21 days to settle.',
    reinvest_status: null,
    m_transparency: 2,
    m_responsiveness: 1,
    m_ease_of_process: 2,
    m_trustworthiness: 2,
    m_overall_satisfaction: 2,
    resolution_status: 'CLOSED_UNRESOLVED',
    follow_up_note: null,
    display_mode: 'INITIALS',
    allow_contact: false,
    declarations_version: '2026-10',
    declarations_accepted_at: '2026-10-27T10:00:00Z',
    status: 'PENDING_MODERATION',
    moderation_note: null,
    published_at: null,
    created_at: '2026-10-27T10:00:00Z',
    updated_at: '2026-10-27T10:00:00Z',
    deleted_at: null,
    company: { id: COMPANY_A, name: 'Astra Mutuals', asset_class: 'MF' },
    review_tags: [
      { tag_type: 'CONTACT_STATUS', code: 'CONTACTED_NO_RESPONSE' },
      { tag_type: 'CONCERN', code: 'MIS_SELLING' },
      { tag_type: 'CONCERN', code: 'DELAY_IN_RESPONSE' },
    ],
    review_attachments: [{ storage_path: EVIDENCE_PATH, doc_type: 'STATEMENT' }],
    review_versions: [
      {
        change_type: 'SUBMITTED',
        from_value: null,
        to_value: 'PENDING_MODERATION',
        note: null,
        created_at: '2026-10-27T10:00:00Z',
      },
    ],
    ...overrides,
  };
}

const declarations = { kycVerified: true, genuine: true, understandInsights: true };
const metrics = {
  transparency: 4,
  responsiveness: 5,
  easeOfProcess: 4,
  trustworthiness: 4,
  overallSatisfaction: 5,
};

export const positiveBody = {
  companyId: COMPANY_A,
  country: 'IN',
  assetClass: 'MF',
  productScheme: 'Bluechip',
  investmentYear: 'OLDER',
  investmentStatus: 'CURRENTLY_INVESTED',
  sentiment: 'Positive',
  appreciations: ['TIMELY_PAYOUTS', 'DIGITAL_EXPERIENCE'],
  detailedReview: 'Payouts always arrived on time.',
  reinvestStatus: 'YES',
  metrics,
  resolutionStatus: 'RESOLVED',
  followUpNote: '',
  displayMode: 'INITIALS',
  declarations,
};

export const negativeBody = {
  companyId: COMPANY_A,
  country: 'IN',
  assetClass: 'MF',
  productScheme: 'Bluechip',
  investmentYear: 2024,
  investmentStatus: 'CURRENTLY_INVESTED',
  sentiment: 'Negative',
  concerns: ['DELAY_IN_RESPONSE'],
  contactStatus: ['CONTACTED_NO_RESPONSE'],
  negativeDescription: 'Redemption took 21 days to settle.',
  evidence: [{ path: EVIDENCE_PATH, docType: 'STATEMENT' }],
  metrics: { ...metrics, overallSatisfaction: 2 },
  resolutionStatus: 'CLOSED_UNRESOLVED',
  declarations,
};
