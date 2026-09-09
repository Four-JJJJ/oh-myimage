UPDATE api_credentials
SET model = 'image-2.5'
WHERE model IN ('gpt-image-2', 'image-2');
