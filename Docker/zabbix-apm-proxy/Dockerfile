ARG ZBX_VERSION=8.0
ARG ZBX_IMAGE_TAG=alpine-trunk

FROM zabbix/zabbix-build-sqlite3:${ZBX_IMAGE_TAG} AS builder

RUN apk add --no-cache grpc-dev protobuf-dev protobuf grpc-plugins pkgconf

WORKDIR ${ZBX_SOURCES_DIR}

RUN ./bootstrap.sh && \
    ./configure \
        --datadir=/usr/lib \
        --libdir=/usr/lib/zabbix \
        --prefix=/usr \
        --sysconfdir=/etc/zabbix \
        --enable-ipv6 \
        --enable-agent \
        --enable-agent2 \
        --enable-java \
        --enable-proxy \
        --with-ares \
        --with-apm \
        --with-ldap \
        --with-libcurl \
        --with-libmodbus \
        --with-libpcre2 \
        --with-libxml2 \
        --with-${DB_TYPE} \
        --with-net-snmp \
        --with-openipmi \
        --with-openssl \
        --with-ssh \
        --with-unixodbc \
        --silent && \
    make -j"$(nproc)" -s

FROM zabbix/zabbix-proxy-sqlite3:${ZBX_IMAGE_TAG}

ARG ZBX_VERSION
USER root
RUN apk add --no-cache grpc protobuf
COPY --from=builder /tmp/zabbix-${ZBX_VERSION}/src/zabbix_proxy/zabbix_proxy /usr/sbin/zabbix_proxy
USER 1997
