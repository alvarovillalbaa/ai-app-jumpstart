# The official 1.4.6 image is AMD64 only. Compose declares that requirement.
FROM --platform=linux/amd64 clamav/clamav:1.5@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0
COPY deploy/upload-scanner-clamd.conf /etc/clamav/clamd.conf
RUN mkdir -p /run/clamav && chown clamav:clamav /run/clamav && chmod 0770 /run/clamav
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=12 CMD clamdscan --config-file=/etc/clamav/clamd.conf --ping=1
