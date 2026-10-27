import { HttpError } from '../../middleware/errorHandler';
import type { LookupType } from '../../types/domain';
import { lookupsRepository } from './lookups.repository';

/** URL slug, as used in `GET /lookups/:type`, to the stored lookup type. */
const TYPE_BY_SLUG: Record<string, LookupType> = {
  'job-profiles': 'JOB_PROFILE',
  focus: 'FOCUS',
  'risk-levels': 'RISK',
  styles: 'STYLE',
  sectors: 'SECTOR',
  'asset-classes': 'ASSET_CLASS',
  'appreciation-tags': 'APPRECIATION_TAG',
  'concern-tags': 'CONCERN_TAG',
  'rating-factors': 'RATING_FACTOR',
  'risk-factors': 'RISK_FACTOR',
  'investor-types': 'INVESTOR_TYPE',
};

export const lookupsService = {
  async listBySlug(slug: string) {
    const type = TYPE_BY_SLUG[slug];
    if (!type) {
      const known = Object.keys(TYPE_BY_SLUG).join(', ');
      throw new HttpError(404, `Unknown lookup type "${slug}". Known types: ${known}`);
    }
    return lookupsRepository.findActive(type);
  },

  /** Returns the codes that are not active options of `type`. */
  async findInvalidCodes(type: LookupType, codes: string[]): Promise<string[]> {
    if (codes.length === 0) return [];
    const valid = new Set(await lookupsRepository.findActiveCodes(type, codes));
    return codes.filter((code) => !valid.has(code));
  },
};
