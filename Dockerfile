# Use the official Ubuntu image as a base image
FROM ubuntu:latest

# Set up an argument for MONGODB_URI
ARG MONGODB_URI

# Set environment variables and work directory
ENV HOME /app
ENV MONGODB_URI=${MONGODB_URI}
WORKDIR /app

# Update the system and install necessary dependencies for building and running the application
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    pkg-config \
    libssl-dev \
    pv \
    nano \
    git \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js, npm, and Yarn
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && npm install --global yarn \
    && rm -rf /var/lib/apt/lists/*

# Copy local Rust code to the container
COPY ./ /app/

# Install Rust and build the application
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && . $HOME/.cargo/env \
    && cargo build --release

# Install dependencies
RUN cd /app/indexer && yarn install

# Set the CMD instruction to navigate to indexer and start the application
CMD ["bash", "-c", "cd /app/indexer && yarn start"]
