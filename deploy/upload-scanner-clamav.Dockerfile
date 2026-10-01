# The official 1.4.6 image is AMD64 only. Compose declares that requirement.
FROM --platform=linux/amd64 clamav/clamav:1.4@sha256:a5f03c12a79dbe9f6d8a527b6bb1ea053fa8dd061d3738a26897f055ee2d9303
COPY deploy/upload-scanner-clamd.conf /etc/clamav/clamd.conf
RUN mkdir -p /run/clamav && chown clamav:clamav /run/clamav && chmod 0770 /run/clamav
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=12 CMD clamdscan --config-file=/etc/clamav/clamd.conf --ping=1
