# syntax=docker/dockerfile:1
# Revizator serveur (docs/REVIZATOR-SERVER.md, § 7). Contexte de construction : la racine du depot.
#   docker build -f deploy/Dockerfile -t revizator-server .
# (deploy/docker-compose.yml le fait pour la stack Komodo.)

# Images .NET 8 sur Ubuntu 24.04 (« noble ») : glibc 2.39, assez recente pour les natives de Whisper.net
# et de sherpa-onnx comme pour Claude Code ; c'est aussi la variante essayee pendant la mise au point.

# ── Construction ──────────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:8.0-noble AS build
WORKDIR /src

# Restauration seule d'abord : la couche des paquets NuGet reste en cache tant que le .csproj ne change pas.
COPY src/Revizator.Server/Revizator.Server.csproj src/Revizator.Server/
RUN dotnet restore src/Revizator.Server/Revizator.Server.csproj -r linux-x64

# Le serveur compile par liens les services de l'hote WPF et copie sa page : seuls ces dossiers servent.
COPY src/Revizator.Server/ src/Revizator.Server/
COPY src/Organizator/Services/ src/Organizator/Services/
COPY src/Organizator/wwwroot/ src/Organizator/wwwroot/
RUN dotnet publish src/Revizator.Server/Revizator.Server.csproj -c Release -r linux-x64 --self-contained false \
        --no-restore -p:DebugType=none -o /app \
    && test -f /app/wwwroot/index.html \
    && test -f /app/runtimes/linux-x64/libwhisper.so \
    && test -f /app/sherpa/linux-x64/libsherpa-onnx-c-api.so

# Le deploiement, montre dans les Reglages et par /api/health : le commit du depot (lu dans .git, sans
# ses objets, voir .dockerignore) et l'heure de construction. Un depot absent laisse le commit vide.
RUN --mount=type=bind,target=/ctx \
    head=$(cat /ctx/.git/HEAD 2>/dev/null || true); \
    case "$head" in \
      "ref: "*) ref=${head#ref: }; \
        commit=$(cat "/ctx/.git/$ref" 2>/dev/null || grep " $ref\$" /ctx/.git/packed-refs 2>/dev/null | cut -d' ' -f1 || true) ;; \
      *) commit=$head ;; \
    esac; \
    commit=$(printf '%s' "$commit" | tr -d '[:space:]' | grep -E '^[0-9a-f]{40,64}$' || true); \
    printf '{"commit":"%s","builtAt":"%s"}\n' "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /app/build-info.json \
    && cat /app/build-info.json

# ── Execution ─────────────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/aspnet:8.0-noble
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ffmpeg : decodage audio hors WAV. libgomp1 : OpenMP, exige par libggml-cpu-whisper.so (Whisper.net).
# curl : installeur de Claude Code et HEALTHCHECK.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgomp1 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Utilisateur non root : « app » (UID 1654), fourni par l'image .NET. /data lui appartient (le dossier
# monte depuis l'hote doit en faire autant : chown 1654:1654). La commande revizator-server lance la meme
# DLL que le conteneur (docker exec -it revizator revizator-server user set <identifiant>, session list…).
RUN mkdir -p /data /home/app \
    && chown "$APP_UID:$APP_UID" /data /home/app \
    && printf '#!/bin/sh\nexec dotnet /app/revizator-server.dll "$@"\n' > /usr/local/bin/revizator-server \
    && chmod 755 /usr/local/bin/revizator-server

USER $APP_UID
ENV HOME=/home/app \
    PATH=/home/app/.local/bin:$PATH \
    DISABLE_AUTOUPDATER=1

# Claude Code, installeur natif officiel (binaire dans ~/.local/bin). Mises a jour automatiques coupees :
# on change de version en reconstruisant l'image (CLAUDE_CODE_VERSION, ou construction sans cache).
ARG CLAUDE_CODE_VERSION=stable
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "$CLAUDE_CODE_VERSION" \
    && claude --version

# Le programme en dernier : une modification du code ne refait ni apt ni Claude Code. Fichiers a root,
# en lecture seule pour « app ».
COPY --from=build /app /app
WORKDIR /app

# ASPNETCORE_HTTP_PORTS (pose par l'image) est vide ici : le port vient de REVIZATOR_PORT.
ENV REVIZATOR_DATA=/data \
    REVIZATOR_PORT=8080 \
    ASPNETCORE_HTTP_PORTS= \
    DOTNET_NOLOGO=1

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${REVIZATOR_PORT:-8080}/api/health" > /dev/null || exit 1

ENTRYPOINT ["dotnet", "/app/revizator-server.dll"]
