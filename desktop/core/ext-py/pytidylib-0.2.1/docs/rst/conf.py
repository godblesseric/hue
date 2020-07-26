# Configuration file for Sphinx documentation tool

extensions = ['sphinx.ext.autodoc']

main_doc = "index"

project = "pytidylib"
copyright = "2009 Jason Stitt"
version = "0.1"
language = "en"

html_title = "pytidylib module"

latex_use_modindex = False

latex_documents = [
    (
    main_doc,
    'pytidylib.tex',
    'PyTidyLib documentation',
    'Jason Stitt',
    'howto',
    False,
    )
    ]

