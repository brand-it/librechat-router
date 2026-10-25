NODE ?= node

.PHONY: test lint docker hooks clean

test:
	$(NODE) --test

lint:
	$(NODE) --check server.js
	$(NODE) --check test/router.test.js

docker:
	docker build -t librechat-router .

# Point git at the repo's .githooks directory so pre-commit/commit-msg run.
hooks:
	git config core.hooksPath .githooks
	@echo "git hooks installed (core.hooksPath=.githooks)"

clean:
	rm -f *.log
