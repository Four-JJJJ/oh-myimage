ALTER TABLE api_credentials ADD COLUMN prompt_optimizer_model TEXT NOT NULL DEFAULT 'gpt-5.5';
UPDATE api_credentials SET model = 'image-2' WHERE model = 'gpt-image-2';
