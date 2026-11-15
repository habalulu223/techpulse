"""Profile page routes for all signed-in Techpuls roles."""

import hashlib
import logging

from flask import Blueprint, Response, abort, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required
from sqlalchemy.exc import SQLAlchemyError


MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024
MAX_PROFILE_UPLOAD_OVERHEAD_BYTES = 64 * 1024
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
ALLOWED_THEMES = {"light", "dark"}
ALLOWED_FONT_FAMILIES = {"inter", "system", "serif"}
ALLOWED_FONT_SIZES = {"compact", "default", "large"}
logger = logging.getLogger(__name__)


def detect_image_type(data):
    """Return a supported MIME type only when the file signature matches."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def read_profile_image(image):
    """Read and validate one bounded profile image upload."""
    if not image or not image.filename:
        return None, None, "missing"

    image_data = image.stream.read(MAX_PROFILE_IMAGE_BYTES + 1)
    if len(image_data) > MAX_PROFILE_IMAGE_BYTES:
        return None, None, "too_large"

    image_type = detect_image_type(image_data)
    if image_type not in ALLOWED_IMAGE_TYPES:
        return None, None, "invalid_type"
    return image_data, image_type, None


def create_profile_blueprint(db, user_model, get_recent_reports=None):
    """Create profile endpoints without coupling their logic to app.py."""
    profile = Blueprint("profile", __name__)

    @profile.app_context_processor
    def inject_profile_picture_version():
        image_data = current_user.profile_picture if current_user.is_authenticated else None
        cover_data = current_user.cover_picture if current_user.is_authenticated else None
        return {
            "profile_picture_version": hashlib.sha256(image_data).hexdigest() if image_data else "",
            "cover_picture_version": hashlib.sha256(cover_data).hexdigest() if cover_data else "",
        }

    @profile.route("/profile", methods=["GET", "POST"])
    @login_required
    def profile_page():
        if request.method == "POST":
            action = request.form.get("action", "upload_picture")

            if action == "remove_cover":
                current_user.cover_picture = None
                current_user.cover_picture_mime = None
                db.session.commit()
                flash("Your cover photo has been removed.", "success")
                return redirect(url_for("profile.profile_page"))

            if action == "upload_cover":
                image = request.files.get("cover_picture")
                try:
                    image_data, image_type, error = read_profile_image(image)
                except OSError as error:
                    logger.error(
                        "Cover photo upload could not be read",
                        extra={
                            "user_id": current_user.get_id(),
                            "reason": "read_error",
                            "error_type": type(error).__name__,
                        },
                    )
                    flash("The uploaded cover photo could not be read. Please try again.", "error")
                    return redirect(url_for("profile.profile_page"))

                if error == "missing":
                    flash("Choose a JPG, PNG, or WebP image for your cover photo.", "error")
                    return redirect(url_for("profile.profile_page"))
                if error == "too_large":
                    flash("Cover photos must be 2 MB or smaller.", "error")
                    return redirect(url_for("profile.profile_page"))
                if error == "invalid_type":
                    flash("Upload a valid JPG, PNG, or WebP cover photo.", "error")
                    return redirect(url_for("profile.profile_page"))

                current_user.cover_picture = image_data
                current_user.cover_picture_mime = image_type
                try:
                    db.session.commit()
                except SQLAlchemyError as error:
                    db.session.rollback()
                    logger.error(
                        "Cover photo could not be saved",
                        extra={
                            "user_id": current_user.get_id(),
                            "reason": "database_error",
                            "error_type": type(error).__name__,
                        },
                    )
                    flash("The cover photo could not be saved. Please try again.", "error")
                    return redirect(url_for("profile.profile_page"))
                flash("Your cover photo has been saved.", "success")
                return redirect(url_for("profile.profile_page"))

            if action == "remove_picture":
                current_user.profile_picture = None
                current_user.profile_picture_mime = None
                db.session.commit()
                flash("Your profile picture has been removed.", "success")
                return redirect(url_for("profile.profile_page"))

            image = request.files.get("profile_picture")
            try:
                image_data, image_type, error = read_profile_image(image)
            except OSError as error:
                logger.error(
                    "Profile picture upload could not be read",
                    extra={
                        "user_id": current_user.get_id(),
                        "reason": "read_error",
                        "error_type": type(error).__name__,
                    },
                )
                flash("The uploaded picture could not be read. Please try again.", "error")
                return redirect(url_for("profile.profile_page"))

            if error == "missing":
                logger.warning(
                    "Profile picture upload rejected",
                    extra={"user_id": current_user.get_id(), "reason": error},
                )
                flash("Choose a JPG, PNG, or WebP image to upload.", "error")
                return redirect(url_for("profile.profile_page"))
            if error == "too_large":
                logger.warning(
                    "Profile picture upload rejected",
                    extra={"user_id": current_user.get_id(), "reason": error},
                )
                flash("Profile pictures must be 2 MB or smaller.", "error")
                return redirect(url_for("profile.profile_page"))
            if error == "invalid_type":
                logger.warning(
                    "Profile picture upload rejected",
                    extra={"user_id": current_user.get_id(), "reason": error},
                )
                flash("Upload a valid JPG, PNG, or WebP image.", "error")
                return redirect(url_for("profile.profile_page"))

            current_user.profile_picture = image_data
            current_user.profile_picture_mime = image_type
            try:
                db.session.commit()
            except SQLAlchemyError as error:
                db.session.rollback()
                logger.error(
                    "Profile picture upload could not be saved",
                    extra={
                        "user_id": current_user.get_id(),
                        "reason": "database_error",
                        "error_type": type(error).__name__,
                    },
                )
                flash("The picture could not be saved. Please try again.", "error")
                return redirect(url_for("profile.profile_page"))
            flash("Your profile picture has been saved.", "success")
            return redirect(url_for("profile.profile_page"))

        role_name = "Administrator" if current_user.is_admin else (current_user.role or "student").replace("_", " ").title()
        recent_reports = []
        reports_url = None
        if get_recent_reports is not None:
            recent_reports, reports_url = get_recent_reports(current_user)
        return render_template(
            "profile.html",
            profile_user=current_user,
            profile_name=current_user.full_name or current_user.username,
            profile_role=role_name,
            recent_reports=recent_reports,
            reports_url=reports_url,
        )

    @profile.route("/profile/picture")
    @login_required
    def profile_picture():
        user = db.session.get(user_model, int(current_user.get_id()))
        if not user or not user.profile_picture or user.profile_picture_mime not in ALLOWED_IMAGE_TYPES:
            abort(404)
        response = Response(user.profile_picture, mimetype=user.profile_picture_mime)
        response.headers["Cache-Control"] = "private, max-age=300"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @profile.route("/profile/cover")
    @login_required
    def cover_picture():
        user = db.session.get(user_model, int(current_user.get_id()))
        if not user or not user.cover_picture or user.cover_picture_mime not in ALLOWED_IMAGE_TYPES:
            abort(404)
        response = Response(user.cover_picture, mimetype=user.cover_picture_mime)
        response.headers["Cache-Control"] = "private, max-age=300"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @profile.route("/profile/password", methods=["GET", "POST"])
    @login_required
    def password_page():
        if request.method == "POST":
            current_password = request.form.get("current_password", "")
            new_password = request.form.get("new_password", "")
            confirm_password = request.form.get("confirm_password", "")

            if not current_user.check_password(current_password):
                flash("Your current password is incorrect.", "error")
            elif len(new_password) < 8:
                flash("Your new password must be at least 8 characters.", "error")
            elif new_password != confirm_password:
                flash("The new passwords do not match.", "error")
            elif new_password == current_password:
                flash("Choose a password different from your current one.", "error")
            else:
                current_user.set_password(new_password)
                db.session.commit()
                flash("Your password has been changed.", "success")
                return redirect(url_for("profile.profile_page"))
            return redirect(url_for("profile.password_page"))

        return render_template("change_password.html")

    @profile.route("/settings", methods=["GET", "POST"])
    @login_required
    def settings_page():
        if request.method == "POST":
            theme = request.form.get("theme", "light")
            font_family = request.form.get("font_family", "inter")
            font_size = request.form.get("font_size", "default")

            if theme not in ALLOWED_THEMES:
                theme = "light"
            if font_family not in ALLOWED_FONT_FAMILIES:
                font_family = "inter"
            if font_size not in ALLOWED_FONT_SIZES:
                font_size = "default"

            current_user.theme = theme
            current_user.font_family = font_family
            current_user.font_size = font_size
            db.session.commit()
            flash("Your appearance settings have been saved.", "success")
            return redirect(url_for("profile.settings_page"))

        preferences = {
            "theme": current_user.theme or "light",
            "font_family": current_user.font_family or "inter",
            "font_size": current_user.font_size or "default",
        }
        return render_template("settings.html", preferences=preferences)

    return profile
