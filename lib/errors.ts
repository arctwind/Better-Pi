export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function rethrowAfterCleanup(error: unknown, cleanup: () => void | Promise<void>): Promise<never> {
	try {
		await cleanup();
	} catch (cleanupError) {
		throw new AggregateError([error, cleanupError], `${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`, { cause: error });
	}
	throw error;
}
