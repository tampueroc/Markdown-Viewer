FROM nginx:alpine

# Keep the web image static and independent of Node or the desktop build.
COPY index.html 404.html /usr/share/nginx/html/
COPY workspace-storage.js visual-settings-adapters.js visual-settings-store.js /usr/share/nginx/html/
COPY script.js native-markdown-source.js preview-worker.js styles.css sw.js /usr/share/nginx/html/
COPY sample.md RELEASE_NOTES manifest.json robots.txt sitemap.xml /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/
COPY seo/locales.mjs seo/welcome-content.mjs /usr/share/nginx/html/seo/
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Validate the configuration at build time as well as container startup.
RUN nginx -t

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
