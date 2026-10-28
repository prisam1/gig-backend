import { z } from 'zod';
import { Constants } from '../types/database';

// zod schemas for database enums. Built from the same tuples as the DB types, so they cannot drift.
const E = Constants.public.Enums;

export const assetClassSchema = z.enum(E.asset_class);
export const countrySchema = z.enum(E.market_country);
export const sentimentSchema = z.enum(E.sentiment);
export const investmentStatusSchema = z.enum(E.investment_status);
export const reinvestStatusSchema = z.enum(E.reinvest_status);
export const resolutionStatusSchema = z.enum(E.resolution_status);
export const resolutionBucketSchema = z.enum(E.resolution_bucket);
export const displayModeSchema = z.enum(E.display_mode);
export const reviewStatusSchema = z.enum(E.review_status);

export const uuidSchema = z.uuid({ message: 'Must be a valid id' });

export const currencySchema = z.enum(E.currency_code);
export const contentAccessSchema = z.enum(E.content_access);
export const learnFormatSchema = z.enum(E.learn_format);
export const savedEntityTypeSchema = z.enum(E.saved_entity_type);
export const devicePlatformSchema = z.enum(E.device_platform);
export const questionCategorySchema = z.enum(E.question_category);
export const poolExpectationSchema = z.enum(E.pool_expectation);
