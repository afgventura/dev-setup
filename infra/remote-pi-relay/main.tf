# Remote Pi relay — self-hosted so no third party sees agent traffic.
# https://github.com/ZainCheung/remote_pi (relay/ subdirectory)
#
# One Cloud Run service (single instance: the relay keeps mesh state in a
# local SQLite file), image proxied from Docker Hub through an Artifact
# Registry remote repository (Cloud Run cannot pull docker.io directly).
# WebSocket clients dial out to the service URL; no inbound ports on the Mac.

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
  backend "gcs" {
    bucket = "halo-ai-469606-tfstate"
    prefix = "remote-pi-relay"
  }
}

variable "project" {
  default = "halo-ai-469606"
}
variable "region" {
  default = "asia-southeast2"
}
variable "image_tag" {
  default = "latest"
}

provider "google" {
  project = var.project
  region  = var.region
}

resource "google_artifact_registry_repository" "dockerhub" {
  location      = var.region
  repository_id = "dockerhub"
  description   = "Pull-through cache for Docker Hub images used by Cloud Run"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"
  remote_repository_config {
    description = "docker hub"
    docker_repository {
      public_repository = "DOCKER_HUB"
    }
  }
}

resource "google_service_account" "relay" {
  account_id   = "remote-pi-relay"
  display_name = "Remote Pi relay (Cloud Run runtime)"
}

resource "google_cloud_run_v2_service" "relay" {
  name                = "remote-pi-relay"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.relay.email
    timeout         = "3600s" # WebSocket connections; clients reconnect after
    scaling {
      min_instance_count = 1 # keep the socket up; no cold start when the phone connects
      max_instance_count = 1 # SQLite mesh db is per-instance
    }
    containers {
      image = "${var.region}-docker.pkg.dev/${var.project}/${google_artifact_registry_repository.dockerhub.repository_id}/jacobmoura7/remote-pi-relay:${var.image_tag}"
      ports {
        container_port = 3000
      }
      env {
        name  = "REMOTEPI_RELAY_PORT"
        value = "3000"
      }
      env {
        name  = "REMOTEPI_MESH_DB_PATH"
        value = "/tmp/mesh.db" # in-memory fs; mesh membership is re-registered by clients
      }
      env {
        name  = "RUST_LOG"
        value = "info"
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = false # keep CPU on between requests so idle sockets stay serviced
      }
      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 2
        period_seconds        = 5
        failure_threshold     = 6
      }
    }
  }
}

# Unauthenticated at the HTTP layer: the relay authenticates peers itself
# (Ed25519 handshake); only paired keys can be routed to.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.relay.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "relay_url" {
  description = "Paste as https://… in `/remote-pi relay url` and in the app settings"
  value       = google_cloud_run_v2_service.relay.uri
}
