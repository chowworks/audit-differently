# Installation

## Prerequisites

You must have these items before you start:

- Node 22 or later
- The Railway CLI
- A Railway token

### Node

The minimum version is Node 22. You can use a later version.

We recommend nvm to install and manage Node. Install nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

Close the terminal and open a new terminal. Then go to the root of the repository and install Node:

```bash
nvm install
nvm use
```

These commands read the version from `.nvmrc`.

### Railway CLI

Install the Railway CLI with npm:

```bash
npm install -g @railway/cli
```

Make sure that the CLI is installed:

```bash
railway --version
```

### Railway token

To get the Railway token, ask Chris.

Add the token to your shell profile (`~/.bashrc` or `~/.zshrc`):

```bash
export RAILWAY_TOKEN=<your-token>
```

Close the terminal and open a new terminal.

## First-time setup

Install the packages and copy the environment file:

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
```

In `apps/web/.env.local`, set these variables:

- `VITE_API_URL`: the api-dev domain. Do not put a `/` at the end of the URL.
- `VITE_CLERK_PUBLISHABLE_KEY`: the dev Clerk publishable key.

## Start the web app

```bash
npm run dev -w @ad/web
```

The web app runs on http://localhost:5173. It uses api-dev.

## The demo

For the demo users, the demo story and the reset command, refer to [docs/dev-api.md](docs/dev-api.md).

# Development

## Feature

If your change affects the API or the database, deploy the change to api-dev:

```bash
apps/api/scripts/deploy-dev.sh
```

Then restart the local web server and test the change.

## CI gates

Do these commands before you push. CI does the same commands.

```bash
npm run lint
npm run format:check
npm run typecheck
npm run build
npm run test
```

## Open a PR

Request a review from Copilot.
