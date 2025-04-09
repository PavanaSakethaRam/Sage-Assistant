import logging
import sys

def setup_logger(level=logging.INFO):
    logger = logging.getLogger("SageAssistant")
    logger.setLevel(level)
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(level)
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    ch.setFormatter(formatter)
    if not logger.handlers:
        logger.addHandler(ch)
    return logger

if __name__ == "__main__":
    logger = setup_logger(logging.DEBUG)
    logger.debug("DEBUG message.")
    logger.info("INFO message.")
    logger.error("ERROR message.")
