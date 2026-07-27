# Test Fixtures

## SSH Keys
Generate test keys (not committed — add to .gitignore):
```bash
ssh-keygen -t ed25519 -f test/fixtures/ssh/test_key -N ""
```

The Docker test SSH server uses `test_key.pub` for authorized_keys.

## Integration Test Config
Tests use localhost:2222 (and 2223 for multi-host tests).
Auth: password `testpass` or key from `test/fixtures/ssh/test_key`.
