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

# Copy local Rust code to the container
COPY ./ /app/

# Install Rust and build the application
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && . $HOME/.cargo/env \
    && cargo build --release

# Add a startup script and change permissions while still root
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Add the directory containing the executable to the PATH
ENV PATH="/app:${PATH}"

# Set the CMD instruction with additional flags
ENTRYPOINT ["/start.sh"]
