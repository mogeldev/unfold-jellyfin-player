"""Errors carry a code instead of text: the frontend translates it ('err_<code>' in web/locales/*.js), params fill the placeholders."""


class AppError(Exception):
    def __init__(self, code: str, **params):
        super().__init__(code)
        self.code = code
        self.params = params
