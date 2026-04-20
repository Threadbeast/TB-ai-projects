# Reverse proxy for the TB multi-project deployment.
# Routes:
#   /analyzer/*  → $ANALYZER_URL  (strips the /analyzer prefix)
#   /pipeline/*  → $PIPELINE_URL  (strips the /pipeline prefix)
#   /            → landing page (index.html)
#
# On Cloud Run, set ANALYZER_URL and PIPELINE_URL to the https://*.run.app
# URLs of those services (without a trailing slash). The image honours
# Cloud Run's $PORT convention via nginx's built-in envsubst template support.
FROM nginx:alpine

# These defaults are fine for local docker-compose; Cloud Run will override
# via --set-env-vars.
ENV PORT=80 \
    ANALYZER_UPSTREAM="hate-it-rate-analyzer:3000" \
    PIPELINE_UPSTREAM="pipeline:80" \
    ANALYZER_SCHEME="http" \
    PIPELINE_SCHEME="http" \
    NGINX_RESOLVER="8.8.8.8 8.8.4.4" \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d

COPY proxy.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=644 index.html /usr/share/nginx/html/index.html
COPY --chmod=644 background.jpg /usr/share/nginx/html/background.jpg
COPY --chmod=644 logo.svg /usr/share/nginx/html/logo.svg

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
