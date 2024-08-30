# Use the official Ubuntu image as a base image
FROM ubuntu:latest AS build

# Set up an argument for MONGODB_URI
ARG MONGODB_URI

# Set environment variables and work directory
ENV HOME /app
ENV MONGODB_URI=${MONGODB_URI}
WORKDIR /app

# Update the system and install necessary dependencies
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy local Rust code to the container
COPY ./ /app/

# Install Rust and build the application
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && . $HOME/.cargo/env \
    && cd /app \
    && cargo build --release

# Use a new stage to create the final image
FROM ubuntu:latest

# Set work directory
WORKDIR /app

# Update the system and install necessary dependencies in the final image
RUN apt-get update && apt-get install -y \
    pv \
    nano \
    git \
    curl \
    sudo \
    build-essential \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy the ord program from the build stage
COPY --from=build /app/target/release/ord /app/ord

# Add a startup script and change permissions while still root
COPY start.sh /start.sh

RUN chmod +x /start.sh

# Create a directory for Yarn PID file
RUN mkdir -p /var/run

# Add the directory containing the executable to the PATH
ENV PATH="/app:${PATH}"

# Set the CMD instruction with additional flags
ENTRYPOINT ["/start.sh"]
