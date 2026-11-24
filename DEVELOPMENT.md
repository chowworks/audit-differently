# Installation and Development

## Local development

**Prerequisites:** Node 22.

Install the packages and copy the environment files:

```bash
npm install
cp apps/api/.env.example apps/api/.env       # Dev keys. railway-dev-vars.sh copies them to api-dev (docs/dev-api.md).
cp apps/web/.env.example apps/web/.env.local # The api-dev domain and the dev Clerk publishable key.
```

### Start the web app

```bash
npx prisma generate --schema apps/api/prisma/schema.prisma   # Makes the Prisma client. Do this before typecheck.
npm run dev -w @ad/web     # Starts the web app on http://localhost:5173. It uses api-dev.
```

## The demo

For the demo users, the demo story and the reset command, refer to [docs/dev-api.md](docs/dev-api.md).

## CI gates

Do these commands before you push. CI does the same commands.

```bash
npm run lint
npm run format:check
npm run typecheck
npm run build
npm run test
```
