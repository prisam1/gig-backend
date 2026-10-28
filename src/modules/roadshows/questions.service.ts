import type { PageMeta } from '../../lib/http';
import { containsPattern, fetchPage, supabaseAdmin, unwrap } from '../../lib/supabase';
import { HttpError } from '../../middleware/errorHandler';
import type { Enums, Tables } from '../../types/database';
import type { AuthUser } from '../../middleware/auth';
import type { AskQuestionInput, ListQuestionsQuery } from './roadshows.schemas';
import { findPublishedRoadshow } from './roadshows.service';

/** A published Ask Me Anything question. The asker is never shown. */
export interface RoadshowQuestion {
  id: string;
  category: Enums<'question_category'>;
  question: string;
  /** The issuer's answer, once GIG staff publish it. */
  answer: string | null;
  answeredAt: string | null;
  featured: boolean;
  createdAt: string;
}

/** The asker's view right after submitting: moderation status included. */
export interface SubmittedQuestion extends RoadshowQuestion {
  status: Enums<'question_status'>;
}

type QuestionRow = Pick<
  Tables<'roadshow_questions'>,
  'id' | 'category' | 'question' | 'answer' | 'answered_at' | 'featured' | 'created_at'
>;

const QUESTION_COLUMNS = 'id, category, question, answer, answered_at, featured, created_at';

function toQuestion(row: QuestionRow): RoadshowQuestion {
  return {
    id: row.id,
    category: row.category,
    question: row.question,
    answer: row.answer,
    answeredAt: row.answered_at,
    featured: row.featured,
    createdAt: row.created_at,
  };
}

export async function listQuestions(
  roadshowId: string,
  query: ListQuestionsQuery,
): Promise<{ items: RoadshowQuestion[]; meta: PageMeta }> {
  await findPublishedRoadshow(roadshowId);

  const build = (head: boolean) => {
    let q = supabaseAdmin
      .from('roadshow_questions')
      .select(QUESTION_COLUMNS, { count: 'exact', head })
      .eq('roadshow_id', roadshowId)
      .eq('status', 'PUBLISHED');
    if (query.category?.length) q = q.in('category', query.category);
    if (query.q) q = q.ilike('question', containsPattern(query.q));
    return q;
  };

  const { rows, meta } = await fetchPage(query, {
    rows: (from, to) => {
      let q = build(false);
      // Top Asked: staff-featured first, then answered questions, newest answers first.
      if (query.sort === 'top') {
        q = q
          .order('featured', { ascending: false })
          .order('answered_at', { ascending: false, nullsFirst: false });
      }
      return q.order('created_at', { ascending: false }).order('id').range(from, to);
    },
    count: () => build(true),
  });
  return { items: rows.map(toQuestion), meta };
}

/** Prive: ask a question while the roadshow is open. It is published after moderation. */
export async function askQuestion(
  user: AuthUser,
  roadshowId: string,
  input: AskQuestionInput,
): Promise<SubmittedQuestion> {
  const roadshow = await findPublishedRoadshow(roadshowId);
  if (!roadshow.isOpen) {
    throw new HttpError(409, 'This roadshow is not taking questions', { code: 'ROADSHOW_CLOSED' });
  }

  const row = unwrap(
    await supabaseAdmin
      .from('roadshow_questions')
      .insert({
        roadshow_id: roadshowId,
        user_id: user.id,
        category: input.category,
        question: input.question,
      })
      .select(`${QUESTION_COLUMNS}, status`)
      .single(),
  );
  return { ...toQuestion(row), status: row.status };
}
