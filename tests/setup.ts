// Supplier stock verification is near-instant and never times out in tests
// unless a test overrides these explicitly.
process.env.SUPPLIER_VERIFY_DELAY_MS ??= "1";
process.env.SUPPLIER_VERIFY_TIMEOUT_MS ??= "1000";
