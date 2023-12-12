# Use the official Ubuntu image as a base image
FROM ubuntu:latest AS build

# Set environment variables and work directory
ENV HOME /app
WORKDIR /app

# Update the system and install necessary dependencies
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
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
    && rm -rf /var/lib/apt/lists/*

# Copy the ord program from the build stage
COPY --from=build /app/target/release /app

# Add a startup script and change permissions while still root
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Add the directory containing the executable to the PATH
ENV PATH="/app:${PATH}"

# Expose port 8080
EXPOSE 8080

# Set the CMD instruction with additional flags
ENTRYPOINT ["/start.sh"]