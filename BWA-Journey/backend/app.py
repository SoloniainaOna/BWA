import os
import io
import re
import uuid
import base64
import logging
import time

import requests as http_requests
from flask import Flask, request, jsonify
from PIL import Image

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Instagram Graph API credentials (Business/Creator account)
IG_ACCESS_TOKEN = os.environ.get("IG_ACCESS_TOKEN", "")
IG_USER_ID = os.environ.get("IG_USER_ID", "")
PUBLIC_URL = os.environ.get("PUBLIC_URL", "").rstrip("/")

# Shared upload directory served by nginx
UPLOAD_DIR = "/uploads"
GRAPH_API = "https://graph.facebook.com/v21.0"


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/post", methods=["POST"])
def post_to_feed():
    """Publish a photo to the Instagram feed via the official Graph API."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON body"}), 400

        image_b64 = data.get("image")
        username = data.get("username", "").strip().lstrip("@")

        if not image_b64:
            return jsonify({"error": "Missing image data"}), 400
        if not username:
            return jsonify({"error": "Missing username"}), 400
        if not re.match(r"^[a-zA-Z0-9._]{1,30}$", username):
            return jsonify({"error": "Invalid Instagram username"}), 400
        if not IG_ACCESS_TOKEN or not IG_USER_ID or not PUBLIC_URL:
            return jsonify({"error": "Instagram API not configured"}), 500

        # --- 1. Decode and prepare the image ---
        if "," in image_b64:
            image_b64 = image_b64.split(",", 1)[1]

        image_bytes = base64.b64decode(image_b64)
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")

        # Instagram feed posts: 1080x1080 (1:1) works best
        target = 1080
        img_ratio = img.width / img.height

        if img_ratio > 1:
            new_w = target
            new_h = int(target / img_ratio)
        else:
            new_h = target
            new_w = int(target * img_ratio)

        img = img.resize((new_w, new_h), Image.LANCZOS)

        canvas = Image.new("RGB", (target, target), (0, 0, 0))
        canvas.paste(img, ((target - new_w) // 2, (target - new_h) // 2))

        # Save to shared volume served by nginx
        filename = f"{uuid.uuid4().hex}.jpg"
        filepath = os.path.join(UPLOAD_DIR, filename)
        canvas.save(filepath, "JPEG", quality=95)

        image_url = f"{PUBLIC_URL}/uploads/{filename}"
        caption = f"Created by @{username} \u2728\n#BWAJourney #Art #Filter"

        try:
            # --- 2. Create media container ---
            create_resp = http_requests.post(
                f"{GRAPH_API}/{IG_USER_ID}/media",
                data={
                    "image_url": image_url,
                    "caption": caption,
                    "access_token": IG_ACCESS_TOKEN,
                },
                timeout=30,
            )
            create_data = create_resp.json()

            if "id" not in create_data:
                error_msg = create_data.get("error", {}).get("message", "Unknown error")
                logger.error(f"Media container creation failed: {error_msg}")
                return jsonify({"error": f"Instagram API error: {error_msg}"}), 502

            container_id = create_data["id"]

            # --- 3. Wait for container to be ready ---
            for _ in range(10):
                status_resp = http_requests.get(
                    f"{GRAPH_API}/{container_id}",
                    params={
                        "fields": "status_code",
                        "access_token": IG_ACCESS_TOKEN,
                    },
                    timeout=10,
                )
                status = status_resp.json().get("status_code")
                if status == "FINISHED":
                    break
                if status == "ERROR":
                    return jsonify({"error": "Instagram rejected the image"}), 502
                time.sleep(2)

            # --- 4. Publish ---
            publish_resp = http_requests.post(
                f"{GRAPH_API}/{IG_USER_ID}/media_publish",
                data={
                    "creation_id": container_id,
                    "access_token": IG_ACCESS_TOKEN,
                },
                timeout=30,
            )
            publish_data = publish_resp.json()

            if "id" not in publish_data:
                error_msg = publish_data.get("error", {}).get("message", "Unknown error")
                logger.error(f"Publish failed: {error_msg}")
                return jsonify({"error": f"Publish failed: {error_msg}"}), 502

            logger.info(f"Post published (id={publish_data['id']}) mentioning @{username}")
            return jsonify({"success": True, "post_id": publish_data["id"]})

        finally:
            # Clean up the temporary image
            try:
                os.unlink(filepath)
            except OSError:
                pass

    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        return jsonify({"error": "Failed to post. Please try again."}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
