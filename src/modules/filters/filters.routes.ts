import { Router } from 'express';
import { callDb } from '../../lib/db';
import { sendData } from '../../lib/http';
import { parse } from '../../middleware/validate';
import { filterCountsQuery, type FilterCounts, type FilterSection } from './filters.schemas';

/** `/filters`: live numbers for the filter sheet of each tab. */
export const filtersRouter = Router();

export function filterCounts(section: FilterSection): Promise<FilterCounts> {
  return callDb('app_filter_counts', { p_section: section });
}

// GET /filters/counts?section=reviews — Public: the count (or share) next to each option.
filtersRouter.get('/counts', async (req, res) => {
  const { section } = parse(filterCountsQuery, req.query);
  sendData(res, await filterCounts(section));
});
