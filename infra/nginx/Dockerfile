FROM nginx:1.29-alpine

# openssl solo para generar el certificado autofirmado de desarrollo al arrancar.
RUN apk add --no-cache openssl

COPY 10-dev-certificate.sh /docker-entrypoint.d/10-dev-certificate.sh
COPY nginx.conf /etc/nginx/nginx.conf
RUN rm -f /etc/nginx/conf.d/default.conf
COPY conf.d/ /etc/nginx/conf.d/

RUN chmod +x /docker-entrypoint.d/10-dev-certificate.sh
