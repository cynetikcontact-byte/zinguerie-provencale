FROM node:24-alpine AS build
WORKDIR /app
COPY package.json index.html ./
COPY assets ./assets
COPY scripts/build.cjs ./scripts/build.cjs
RUN node scripts/build.cjs
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1/health.json || exit 1
