FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY scss ./scss
RUN npm run build:css

FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY --from=build /app/public/css ./public/css

RUN mkdir -p data

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "server/index.js"]
