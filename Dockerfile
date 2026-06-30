FROM node:18-alpine AS builder
WORKDIR /app

# Vite inlines VITE_* at build time: receive them as build-args and
# expose them as env so `npm run build` picks them up.
ARG VITE_HERMES_API_URL
ARG VITE_HERMES_API_KEY
ARG VITE_HERMES_WS_URL
ENV VITE_HERMES_API_URL=$VITE_HERMES_API_URL
ENV VITE_HERMES_API_KEY=$VITE_HERMES_API_KEY
ENV VITE_HERMES_WS_URL=$VITE_HERMES_WS_URL

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
