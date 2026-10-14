// Keep large route collections from sending one request per route at once.
export async function mapWithConcurrency(items, map, concurrency = 4) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await map(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, worker));
    return results;
}
