"""Fehler mit Code statt Text: das Frontend übersetzt ('err_<code>' in web/locales/*.js), params füllen die Platzhalter."""


class AppError(Exception):
    def __init__(self, code: str, **params):
        super().__init__(code)
        self.code = code
        self.params = params
