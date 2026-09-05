/**
 * Boards that must never feed the radar, even if the catalog or Google discovery lists them.
 * Federal contractors post hundreds of cleared/on-site roles that swamp the feed.
 */
// federal contractors (cleared, on-site roles); EWOR (a German founder-fellowship advertising "jobs" in every US city);
// Jobgether (an aggregator reposting other companies' openings).
export const excludedBoardPattern = /federal|ewor ?gmbh|jobgether/i;

export function isExcludedBoard(board: { slug: string; companyName?: string | null }) {
  return excludedBoardPattern.test(board.slug) || excludedBoardPattern.test(board.companyName ?? "");
}

/** SQL fragment of the same rule, for the queries that pick boards to validate or scan. */
export const excludedBoardLikes = ["%federal%", "%ewor gmbh%", "%eworgmbh%", "%jobgether%"];
/** @deprecated use excludedBoardLikes */
export const excludedBoardLike = "%federal%";
