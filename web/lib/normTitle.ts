/**
 * Titles compare the way the server compares them.
 *
 * Must stay identical to `norm` in bff/src/routes/sources.ts: the server's inLibrary check and the
 * search-all grouping are keyed by it, and the client uses the same key to flip a card to "in library" with
 * no refetch, to find the providers behind a card, and to fold the wall to one card per title. Two spellings
 * of this rule would be two answers to "is this the same title". test/wall.test.ts holds the two regexes
 * against each other as text.
 */
export const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
