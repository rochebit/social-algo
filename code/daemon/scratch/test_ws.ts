async function testFetch() {
  const urls = [
    "https://jetstream1.us-west.bsky.network/",
    "https://jetstream2.us-west.bsky.network/"
  ];
  for (const url of urls) {
    try {
      console.log(`Fetching: ${url}`);
      const res = await fetch(url);
      console.log(`✅ Success: ${url} status: ${res.status}`);
    } catch (e: any) {
      console.log(`❌ Fail: ${url} error:`, e.message || String(e));
    }
  }
}

testFetch();
