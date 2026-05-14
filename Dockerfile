FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/migrations ./migrations

EXPOSE 8788
CMD ["npm", "run", "start:node"]
