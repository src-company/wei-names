# The wei.domains publisher for WNS posts (wei_poster.py). Build: docker build -t wei-poster .
FROM python:3.12-slim

COPY requirements.txt /opt/wei-poster/
RUN pip install --no-cache-dir -r /opt/wei-poster/requirements.txt

# The mainnet KZG trusted setup (c-kzg-4844), pinned by hash. test_poster.py checks it reproduces
# real mainnet blob commitments.
ADD --chmod=644 --checksum=sha256:d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7 \
    https://raw.githubusercontent.com/ethereum/c-kzg-4844/main/src/trusted_setup.txt /opt/wei-poster/trusted_setup.txt
COPY wei_poster.py /opt/wei-poster/

RUN useradd --system --uid 10088 --home-dir /data wei-poster && mkdir /data && chown wei-poster /data
USER wei-poster
WORKDIR /data
ENV PYTHONUNBUFFERED=1 POSTER_TRUSTED_SETUP=/opt/wei-poster/trusted_setup.txt POSTER_DB=/data/poster.db
ENTRYPOINT ["python", "/opt/wei-poster/wei_poster.py"]
CMD ["run"]
