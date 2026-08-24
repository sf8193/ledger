.PHONY: help start-db stop-db login-db reset-db run-migrations

DB_CONTAINER = ledger-postgres
DB_USER = postgres
DB_NAME = ledger
DB_PORT = 5434

help:
	@echo "Available commands:"
	@echo "  make start-db        - Start PostgreSQL container"
	@echo "  make stop-db         - Stop PostgreSQL container"
	@echo "  make login-db        - Login to local PostgreSQL database"
	@echo "  make reset-db        - Drop and recreate database"
	@echo "  make run-migrations  - Run pending migrations"

start-db:
	@if [ "$$(docker ps -aq -f name=$(DB_CONTAINER))" ]; then \
		docker start $(DB_CONTAINER) > /dev/null; \
	else \
		docker run -d \
			--name $(DB_CONTAINER) \
			-e POSTGRES_USER=$(DB_USER) \
			-e POSTGRES_PASSWORD=postgres \
			-e POSTGRES_DB=$(DB_NAME) \
			-p $(DB_PORT):5432 \
			postgres:17 > /dev/null; \
	fi
	@echo "PostgreSQL started on port $(DB_PORT)"

stop-db:
	@docker stop $(DB_CONTAINER)
	@echo "PostgreSQL stopped"

login-db:
	@docker exec -it $(DB_CONTAINER) psql -U $(DB_USER) -d $(DB_NAME)

reset-db:
	@echo "Dropping database..."
	@docker exec $(DB_CONTAINER) psql -U $(DB_USER) -c "DROP DATABASE IF EXISTS $(DB_NAME);"
	@echo "Creating database..."
	@docker exec $(DB_CONTAINER) psql -U $(DB_USER) -c "CREATE DATABASE $(DB_NAME);"
	@echo "Database reset complete!"

run-migrations:
	@pnpm run migrate
