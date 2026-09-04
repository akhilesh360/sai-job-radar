/**
 * Boards that must never feed the radar, even if the catalog or Google discovery lists them.
 * Federal contractors post hundreds of cleared/on-site roles that swamp the feed.
 */
export const excludedBoardPattern = /federal/i;

export function isExcludedBoard(board: { slug: string; companyName?: string | null }) {
  return excludedBoardPattern.test(board.slug) || excludedBoardPattern.test(board.companyName ?? "");
}

/** SQL fragment of the same rule, for the queries that pick boards to validate or scan. */
export const excludedBoardLike = "%federal%";
