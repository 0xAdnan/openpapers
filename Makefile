.DEFAULT_GOAL := help

NPM ?= npm
NODE ?= node
VERCEL ?= npx --yes vercel@63.1.2
VERCEL_SCOPE ?= 0xadnans-projects
VERCEL_PROJECT ?= openpapers

.PHONY: help install dev frontend backend worker migrate build build-frontend build-backend test test-e2e check previews link deploy deploy-frontend deploy-backend deploy-checked deploy-prebuilt preview logs status push

help:
	@printf '%s\n' \
	  'make dev              Start frontend and backend with optional .env' \
	  'make frontend         Start Vite on port 5173' \
	  'make backend          Start the API on port 3001' \
	  'make worker           Run the durable graph worker' \
	  'make migrate          Apply graph migrations (requires DATABASE_URL)' \
	  'make build            Build frontend and Vercel API bundle' \
	  'make check            Run backend tests, build, and browser tests' \
	  'make deploy           Deploy frontend + API together, build on Vercel' \
	  'make deploy-checked   Verify locally before deploying' \
	  'make deploy-prebuilt  Build locally and upload prebuilt production output' \
	  'make preview          Create a Vercel preview deployment' \
	  'make link             Link this directory to the Vercel project' \
	  'make status / logs    Inspect the project or deployment logs' \
	  'make push             Push committed changes to origin/main (no auto-commit)'

install:
	$(NPM) ci

dev:
	$(NODE) --env-file-if-exists=.env node_modules/concurrently/dist/bin/concurrently.js -k "$(MAKE) frontend" "$(MAKE) backend"

frontend:
	$(NPM) exec vite -- --host 0.0.0.0

backend:
	$(NODE) --env-file-if-exists=.env --watch --import tsx server/index.ts

worker:
	$(NPM) run graph:worker

migrate:
	$(NPM) run graph:migrate

build:
	$(NPM) run build:vercel

build-frontend:
	$(NPM) run build

build-backend:
	$(NODE) scripts/build-vercel.mjs

test:
	$(NPM) test

test-e2e:
	$(NPM) run test:e2e

# Serial execution keeps browser tests on the freshly built frontend, including with -j.
check:
	$(MAKE) test
	$(MAKE) build
	$(MAKE) test-e2e

previews:
	$(NODE) --import tsx scripts/build-featured.ts

link:
	$(VERCEL) link --project $(VERCEL_PROJECT) --scope $(VERCEL_SCOPE) --yes

# Frontend and API use one project; these aliases intentionally deploy both.
deploy deploy-frontend deploy-backend:
	$(VERCEL) deploy --prod --yes --scope $(VERCEL_SCOPE)

deploy-checked:
	$(MAKE) check
	$(MAKE) deploy

deploy-prebuilt:
	$(VERCEL) pull --yes --environment=production --scope $(VERCEL_SCOPE)
	$(VERCEL) build --prod
	$(VERCEL) deploy --prebuilt --prod --yes --scope $(VERCEL_SCOPE)

preview:
	$(VERCEL) deploy --yes --scope $(VERCEL_SCOPE)

logs:
	$(VERCEL) logs https://openpapers-psi.vercel.app --no-follow --scope $(VERCEL_SCOPE)

status:
	$(VERCEL) project inspect $(VERCEL_PROJECT) --scope $(VERCEL_SCOPE)

push:
	git push origin main
