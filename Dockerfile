FROM node:18-alpine AS builder
WORKDIR /app

# Vite inlines VITE_* at build time. With the reverse proxy the browser talks to
# same-origin /api, so only the (relative) API base URL is baked in — no secrets.
ARG VITE_HERMES_API_URL=/api
ENV VITE_HERMES_API_URL=$VITE_HERMES_API_URL

ARG VITE_HERMES_WS_URL
ENV VITE_HERMES_WS_URL=$VITE_HERMES_WS_URL

ARG VITE_OPENAI_API_KEY
ENV VITE_OPENAI_API_KEY=$VITE_OPENAI_API_KEY

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# Copied as a template: the nginx image entrypoint runs envsubst on it and writes
# conf.d/default.conf, injecting HERMES_API_KEY at container start.
COPY nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
